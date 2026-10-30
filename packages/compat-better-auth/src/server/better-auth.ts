import {
  type Auth,
  ConfigError,
  createAuth,
  crossSiteRefusal,
  type HandleOptions,
  onWorkers,
} from "@authtempo/core";
import type { RouteKey } from "@authtempo/core/routes";
import { BetterAuthCompatError } from "../compat-error.js";
import { BETTER_AUTH_CODES, messageOf, passwordPolicyCode } from "../errors.js";
import { isPlaceholder, placeholderRuleOf } from "../storage/placeholder.js";
import type { BetterAuthInstance, BetterAuthOptions } from "../types.js";
import { accountRoute } from "./account.js";
import { adminRefusal, adminRoute } from "./admin.js";
import { createApi } from "./api.js";
import {
  BodyBusy,
  BodyTimeout,
  BodyTooLarge,
  bodyBusy,
  bodyReadable,
  bodyTimeout,
  bodyTooLarge,
  readJsonOf,
} from "./body.js";
import { checkOptions, pluginOf } from "./check-options.js";
import { emailOtpRoute } from "./email-otp.js";
import { PLACEHOLDER_ADDRESS_TEXT } from "./hooks.js";
import { type Mapped, mapOptions, mappedFor } from "./map-options.js";
import { getSessionRoute } from "./session.js";
import { sessionTokenOf } from "./shapes.js";
import { signInAdditionsRoute } from "./sign-in-additions.js";
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
  const path = new URL(copy.url).pathname.slice(mapped.basePath.length);
  const field = PASSWORD_FIELD[path];
  if (!field) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== "password_policy") return res;
  const sent = (await readJsonOf(copy, `POST ${path}` as RouteKey)) as Record<
    string,
    unknown
  > | null;
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
  base: Mapped,
): (request: Request, options?: HandleOptions) => Promise<Response> {
  const { basePath, plugins } = base;
  // Core's own change routes follow Better Auth's option (plan 12a), as the
  // magic link does. The email code paths reach them through auth.handle.
  const changePath = `${basePath}/user/change-email`;
  // Better Auth's own path of the change, which account.ts sends to core's route.
  const betterAuthChangePath = `${basePath}/change-email`;
  // Better Auth has no re-authentication code, and the shim maps no mail for it.
  const reauthCodePath = `${basePath}/reauth/email`;
  const magicLinkPath = `${basePath}/magic-link/`;
  // Core's /tokens and /organizations/tokens routes pass through since plan
  // 12k Task 12: both token models keep core's own tables here.
  const serve = async (request: Request, options?: HandleOptions): Promise<Response> => {
    // A host outside a baseURL list gets core's 421 before any route work,
    // the SAML ACS too (plan 12i Task 18). Core's gate checks the host first,
    // and 421 is its only answer of that rule.
    const hostRefusal = crossSiteRefusal(auth, request);
    if (hostRefusal?.status === 421) return hostNotAllowed(hostRefusal);
    // The request's entry of the list: each inner request and URL is built on it.
    // With the host's waitUntil, each inner auth.handle call passes it on
    // (ruling 23 of plan 12i, Task 16): the request's mapping carries it.
    const entry = mappedFor(base, request);
    const mapped = options?.waitUntil ? { ...entry, handleOptions: options } : entry;
    const { pathname } = new URL(request.url);
    // Core answers 404 outside basePath: one source for that rule (Task 7 ruling).
    // Core always mounts the magic link routes. Better Auth serves them only with the plugin.
    if (!plugins.has("magic-link") && pathname.startsWith(magicLinkPath)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (
      (!base.account.changeEmail &&
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
    if (req.method === "POST" && pathname === changePath) {
      const held = await placeholderChange(auth, base, req, false);
      if (held) return held;
    }
    // With the option off, account.ts answers CHANGE_EMAIL_DISABLED first (ruling 44 L-A).
    if (req.method === "POST" && pathname === betterAuthChangePath && base.account.changeEmail) {
      const held = await placeholderChange(auth, base, req, true);
      if (held) return held;
    }
    // Better Auth's sso and scim paths (plan 12d Task 14). Null for every other request.
    const sso = (await ssoRoute(auth, mapped, req)) ?? (await scimRoute(auth, mapped, req));
    if (sso) return sso;
    // A body read or locked before cannot be cloned: no copy, no policy code (ruling 51 Low 3).
    const copy = req.method === "POST" && bodyReadable(req) ? req.clone() : null;
    // Better Auth's admin calls (plan 12f): the refusals of the calls that core does not
    // serve, then the calls that map onto core's operator routes. Null for every other request.
    const admin = plugins.has("admin")
      ? ((await adminRefusal(mapped, req)) ?? (await adminRoute(auth, mapped, req)))
      : null;
    // Better Auth's get-session and account paths, in Better Auth's shapes (plan 12a). Null for every other request.
    const account =
      admin ??
      (await getSessionRoute(auth, mapped, req)) ??
      (await accountRoute(auth, mapped, req)) ??
      // The paths of the sign-in plugins of plan 12i Task 16. Null for every other request.
      (await signInAdditionsRoute(auth, mapped, req));
    // Better Auth's email OTP paths, in Better Auth's shapes (plan 9e). Null for every other request.
    const otp =
      account ?? (plugins.has("email-otp") ? await emailOtpRoute(auth, mapped, req) : null);
    // Better Auth's two-factor paths (plan 9f). Null for every other request.
    const tf = otp ?? (plugins.has("two-factor") ? await twoFactorRoute(auth, mapped, req) : null);
    let res =
      tf ??
      (await withFreshCode(
        await withPolicyCode(copy, await auth.handle(req, mapped.handleOptions), mapped),
      ));
    if (!tf && plugins.has("two-factor")) res = await withTwoFactor(auth, mapped, req, res);
    if (!plugins.has("bearer")) return res;
    const token = sessionTokenOf(res.headers.getSetCookie());
    if (!token) return res;
    const out = new Response(res.body, res);
    out.headers.set("set-auth-token", token);
    out.headers.append("access-control-expose-headers", "set-auth-token");
    return out;
  };
  // The host gives waitUntil to this entry (plan 12h ruling 3 q5). Each
  // inner auth.handle call gets a waitUntil that keeps its work. That work
  // is a code mail or an SMS that core sends after the answer, then core's
  // flush of its lines (ruling 23 of plan 12i, carried to Task 16). The
  // host gets one promise: the shim's flush and that work. With no waitUntil, the inner
  // calls get none, as before: core then runs the work detached, or waits
  // for it on Workers (ruling 29).
  return async (request, options) => {
    const host = options?.waitUntil;
    const work: Promise<unknown>[] = [];
    // A read of the shim past the cap of its route throws core's BodyTooLarge.
    // It answers 413 PAYLOAD_TOO_LARGE at that first read (ruling 46 of the 12j lane).
    // A large read past the budget of the isolate throws BodyBusy: 503 (ruling 51).
    // A large read past its deadlines throws BodyTimeout: 408 (ruling 59).
    const res = await serve(
      request,
      host ? { waitUntil: (p) => void work.push(p) } : undefined,
    ).catch((e: unknown) => {
      if (e instanceof BodyTooLarge) return bodyTooLarge();
      if (e instanceof BodyBusy) return bodyBusy();
      if (e instanceof BodyTimeout) return bodyTimeout();
      throw e;
    });
    if (host) {
      // The flush has started when a throwing waitUntil returns: the answer stays,
      // and the events reach the sink while the isolate lives.
      const flush = auth.observe.flush();
      try {
        // The promise resolves to undefined, as core's handle gives its host.
        host(Promise.allSettled([flush, ...work]).then(() => undefined));
      } catch {
        // An unbound ctx.waitUntil throws Illegal invocation. The answer is kept.
        // The work took no promise, so on Workers it would stop at the answer.
        // Wait for it, as core's handle does (final fix wave item 14).
        if (work.length > 0 && onWorkers()) await Promise.allSettled(work);
      }
    }
    return res;
  };
}

/**
 * A change of address to an address in a placeholder form answers
 * `hook_refused` before core mails the confirm link (ruling 42 L1). Core's
 * user `beforeUpdate` refuses it at the commit too (hooks.ts), but core
 * mails the new address first. Better Auth's own path `/change-email` gets
 * the refusal in Better Auth's shape (ruling 44 L-A). Null for any other change.
 */
async function placeholderChange(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  betterAuthShape: boolean,
): Promise<Response | null> {
  const body = await readJsonOf(request, "POST /user/change-email");
  const email = (body as { newEmail?: unknown } | null)?.newEmail;
  if (typeof email !== "string") return null;
  const s = await auth.session(request, { refresh: false });
  if (!isPlaceholder(email, mapped.emailDomainName, s?.user.id ?? null)) return null;
  const refusal = betterAuthShape
    ? { code: BETTER_AUTH_CODES.hook_refused, message: PLACEHOLDER_ADDRESS_TEXT }
    : { error: "hook_refused", message: PLACEHOLDER_ADDRESS_TEXT };
  return Response.json(refusal, { status: 403 });
}

/** Core's 421 of a host outside the `baseURL` list in Better Auth's shape, with core's headers. */
function hostNotAllowed(refusal: Response): Response {
  const code = BETTER_AUTH_CODES.host_not_allowed;
  return new Response(JSON.stringify({ code, message: messageOf(code) }), {
    status: refusal.status,
    headers: refusal.headers,
  });
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
  // The storage reads `temp-<id>@<emailDomainName>` as no address (plan 12i
  // Task 16). One storage holds one rule, so a second instance on it with
  // another domain would read the first one's rows as real addresses.
  const rule = options.database ? placeholderRuleOf(options.database) : undefined;
  const domain = pluginOf(options, "anonymous")?.options.emailDomainName ?? null;
  if (rule) {
    if (rule.domain !== null && rule.domain !== domain)
      throw new BetterAuthCompatError([
        `plugins[anonymous].emailDomainName: another instance on this database reads ${rule.domain} as the placeholder domain; one database takes one`,
      ]);
    rule.domain = domain;
  }
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
