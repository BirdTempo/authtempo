import {
  type Auth,
  ConfigError,
  createAuth,
  crossSiteRefusal,
  type HandleOptions,
} from "@authtempo/core";
import { BetterAuthCompatError } from "../compat-error.js";
import { BETTER_AUTH_CODES, messageOf, passwordPolicyCode } from "../errors.js";
import type { BetterAuthInstance, BetterAuthOptions } from "../types.js";
import { accountRoute } from "./account.js";
import { adminRefusal, adminRoute } from "./admin.js";
import { createApi } from "./api.js";
import { checkOptions } from "./check-options.js";
import { emailOtpRoute } from "./email-otp.js";
import { type Mapped, mapOptions } from "./map-options.js";
import { getSessionRoute } from "./session.js";
import { sessionTokenOf } from "./shapes.js";
import { scimRoute, ssoAcsRoute, ssoRoute } from "./sso-routes.js";
import { twoFactorRoute, withTwoFactor } from "./two-factor.js";

/** The JSON field that holds the new password, per core route (core http/routes/password.ts, read 2026-10-10). */
const PASSWORD_FIELD: Record<string, string> = {
  "/password/sign-up": "password",
  "/password/reset": "password",
  "/otp/reset": "password",
  "/password/change": "newPassword",
};

/**
 * Core answers `{ "error": "password_policy" }` for every policy refusal.
 * Better Auth names the two length cases by the configured minimum, so this
 * adds `code` from the request's own password. The client reads it (Task 9),
 * so the client and `api` answer one code. `copy` is a clone of the request,
 * taken before core read the body.
 */
export async function withPolicyCode(
  copy: Request | null,
  res: Response,
  mapped: Mapped,
): Promise<Response> {
  if (!copy || res.status !== 400) return res;
  const field = PASSWORD_FIELD[new URL(copy.url).pathname.slice(mapped.basePath.length)];
  if (!field) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== "password_policy") return res;
  const sent = (await copy.json().catch(() => null)) as Record<string, unknown> | null;
  const password = typeof sent?.[field] === "string" ? (sent[field] as string) : "";
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return Response.json(
    { ...body, code: passwordPolicyCode(password, mapped.minPasswordLength) },
    { status: 400, headers },
  );
}

/**
 * Core answers `{ "error": "session_not_fresh" }` (403) when a route needs a
 * fresh session (plan 12a). This adds Better Auth's code, `SESSION_NOT_FRESH`,
 * so a caller of a core route through the handler reads the code that
 * Better Auth's own paths answer. The status and core's field stay.
 */
export async function withFreshCode(res: Response): Promise<Response> {
  if (res.status !== 403) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== "session_not_fresh") return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return Response.json(
    { ...body, code: BETTER_AUTH_CODES.session_not_fresh },
    { status: 403, headers },
  );
}

/**
 * Serves core's routes under basePath, with the behavior of the bearer, expo,
 * and magicLink plugins. With `{ waitUntil }`, the events flush after the answer.
 */
export function createHandler(
  auth: Auth,
  mapped: Mapped,
): (request: Request, options?: HandleOptions) => Promise<Response> {
  const { basePath, plugins } = mapped;
  // Core's own change routes follow Better Auth's option (plan 12a), as the
  // magic link does. The email code paths reach them through auth.handle.
  const changePath = `${basePath}/user/change-email`;
  // Better Auth has no re-authentication code, and the shim maps no mail for it.
  const reauthCodePath = `${basePath}/reauth/email`;
  const magicLinkPath = `${basePath}/magic-link/`;
  // Core's /tokens and /organizations/tokens routes pass through since plan
  // 12k Task 12: both token models keep core's own tables here.
  const serve = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    // Core answers 404 outside basePath: one source for that rule (Task 7 ruling).
    // Core always mounts the magic link routes. Better Auth serves them only with the plugin.
    if (!plugins.has("magic-link") && pathname.startsWith(magicLinkPath)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (
      (!mapped.account.changeEmail &&
        (pathname === changePath || pathname.startsWith(`${changePath}/`))) ||
      pathname === reauthCodePath
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    let req = request;
    // @better-auth/expo on the server: a native app sends its scheme as expo-origin.
    const expoOrigin = request.headers.get("expo-origin");
    if (plugins.has("expo") && expoOrigin && !request.headers.has("origin")) {
      const headers = new Headers(request.headers);
      headers.set("origin", expoOrigin);
      req = new Request(request, { headers });
    }
    // Core's Origin and Fetch Metadata rules for every POST, PUT, PATCH, and
    // DELETE, before any shim route (plan 12d). The account, email OTP, and
    // two-factor paths answer in the shim. Core's router alone does not see
    // them (plan 12a fix wave, final review F1). The check comes after the
    // expo-origin step, so the scheme of a native app counts.
    // In Better Auth's shape on every path (the lead's ruling): Better Auth
    // 1.7.2 has one origin check, so both of core's rules answer INVALID_ORIGIN.
    // An IdP posts the SAML form cross-site: core's own ACS route takes it (plan 12d Task 14).
    const acs = await ssoAcsRoute(auth, mapped, req);
    if (acs) return acs;
    const refusal = crossSiteRefusal(auth, req);
    if (refusal) return invalidOrigin(refusal);
    // Better Auth's sso and scim paths (plan 12d Task 14). Null for every other request.
    const sso = (await ssoRoute(auth, mapped, req)) ?? (await scimRoute(auth, mapped, req));
    if (sso) return sso;
    const copy = req.method === "POST" ? req.clone() : null;
    // Better Auth's admin calls (plan 12f): the refusals of the calls that core does not
    // serve, then the calls that map onto core's operator routes. Null for every other request.
    const admin = plugins.has("admin")
      ? ((await adminRefusal(mapped, req)) ?? (await adminRoute(auth, mapped, req)))
      : null;
    // Better Auth's get-session and account paths, in Better Auth's shapes (plan 12a). Null for every other request.
    const account =
      admin ??
      (await getSessionRoute(auth, mapped, req)) ??
      (await accountRoute(auth, mapped, req));
    // Better Auth's email OTP paths, in Better Auth's shapes (plan 9e). Null for every other request.
    const otp =
      account ?? (plugins.has("email-otp") ? await emailOtpRoute(auth, mapped, req) : null);
    // Better Auth's two-factor paths (plan 9f). Null for every other request.
    const tf = otp ?? (plugins.has("two-factor") ? await twoFactorRoute(auth, mapped, req) : null);
    let res =
      tf ?? (await withFreshCode(await withPolicyCode(copy, await auth.handle(req), mapped)));
    if (!tf && plugins.has("two-factor")) res = await withTwoFactor(auth, mapped, req, res);
    if (!plugins.has("bearer")) return res;
    const token = sessionTokenOf(res.headers.getSetCookie());
    if (!token) return res;
    const out = new Response(res.body, res);
    out.headers.set("set-auth-token", token);
    out.headers.append("access-control-expose-headers", "set-auth-token");
    return out;
  };
  // The host gives waitUntil to this entry only (plan 12h ruling 3 q5). The
  // inner auth.handle calls are parts of one request and pass nothing, so the
  // flush starts once, after the answer, as auth.handle starts it.
  return async (request, options) => {
    const res = await serve(request);
    if (options?.waitUntil) {
      // The flush has started when a throwing waitUntil returns: the answer stays,
      // and the events reach the sink while the isolate lives.
      const flush = auth.observe.flush();
      try {
        options.waitUntil(flush);
      } catch {
        // An unbound ctx.waitUntil throws Illegal invocation. The answer is kept.
      }
    }
    return res;
  };
}

/**
 * Core's 403 of a cross-site POST, PUT, PATCH, or DELETE in Better Auth's
 * shape, with core's status and headers.
 */
function invalidOrigin(refusal: Response): Response {
  const code = BETTER_AUTH_CODES.origin_not_trusted;
  return new Response(JSON.stringify({ code, message: messageOf(code) }), {
    status: refusal.status,
    headers: refusal.headers,
  });
}

/** Better Auth's `betterAuth(options)` on authtempo. Throws one BetterAuthCompatError at construction (spec 16.1). */
export function betterAuth<O extends BetterAuthOptions>(options: O): BetterAuthInstance<O> {
  const check = checkOptions(options);
  if (check.refusals.length > 0) throw new BetterAuthCompatError(check.refusals);
  for (const n of check.notes) console.info(`authtempo compat: ${n}`);
  const mapped = mapOptions(options);
  let auth: Auth;
  try {
    auth = createAuth(mapped.config);
  } catch (e) {
    if (e instanceof ConfigError) throw new BetterAuthCompatError([`config: ${e.message}`]);
    throw e;
  }
  return {
    handler: createHandler(auth, mapped),
    // createApi answers the redirect only when core gates the sign-in, which
    // needs the plugin (map-options.ts); the instance type says so per options.
    // Through unknown: TypeScript does not compare a deferred conditional type.
    api: createApi(auth, mapped) as unknown as BetterAuthInstance<O>["api"],
    $Infer: {} as BetterAuthInstance<O>["$Infer"],
    options,
    tempo: auth,
  };
}
