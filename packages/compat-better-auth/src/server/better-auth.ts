import { type Auth, ConfigError, createAuth } from "@authtempo/core";
import { BetterAuthCompatError } from "../compat-error.js";
import { passwordPolicyCode } from "../errors.js";
import type { BetterAuthInstance, BetterAuthOptions } from "../types.js";
import { createApi } from "./api.js";
import { checkOptions } from "./check-options.js";
import { emailOtpRoute } from "./email-otp.js";
import { type Mapped, mapOptions } from "./map-options.js";
import { COOKIE_NAME } from "./shapes.js";
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

/** The non-empty session token a response sets, or null. */
function sessionTokenOf(cookies: string[]): string | null {
  const prefix = `${COOKIE_NAME}=`;
  for (const c of cookies) {
    if (!c.startsWith(prefix)) continue;
    const value = c.slice(prefix.length).split(";")[0];
    if (value) return value;
  }
  return null;
}

/** Serves core's routes under basePath, with the behavior of the bearer, expo, and magicLink plugins. */
export function createHandler(auth: Auth, mapped: Mapped): (request: Request) => Promise<Response> {
  const { basePath, plugins } = mapped;
  const magicLinkPath = `${basePath}/magic-link/`;
  // Core serves API tokens in every deployment (plan 8b). This package maps
  // no `apiToken` row until its api-key plan (UNMAPPED_MODELS), and Better
  // Auth has no such route, so the paths answer 404 here.
  const tokensPath = `${basePath}/tokens`;
  return async (request) => {
    const { pathname } = new URL(request.url);
    // Core answers 404 outside basePath: one source for that rule (Task 7 ruling).
    // Core always mounts the magic link routes. Better Auth serves them only with the plugin.
    if (!plugins.has("magic-link") && pathname.startsWith(magicLinkPath)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (pathname === tokensPath || pathname.startsWith(`${tokensPath}/`)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    let req = request;
    // @better-auth/expo on the server: a native app sends its scheme as expo-origin.
    const expoOrigin = request.headers.get("expo-origin");
    if (plugins.has("expo") && expoOrigin && !request.headers.has("origin")) {
      const headers = new Headers(request.headers);
      headers.set("origin", expoOrigin);
      req = new Request(request, { headers });
    }
    const copy = req.method === "POST" ? req.clone() : null;
    // Better Auth's email OTP paths, in Better Auth's shapes (plan 9e). Null for every other request.
    const otp = plugins.has("email-otp") ? await emailOtpRoute(auth, mapped, req) : null;
    // Better Auth's two-factor paths (plan 9f). Null for every other request.
    const tf = otp ?? (plugins.has("two-factor") ? await twoFactorRoute(auth, mapped, req) : null);
    let res = tf ?? (await withPolicyCode(copy, await auth.handle(req), mapped));
    if (!tf && plugins.has("two-factor")) res = await withTwoFactor(auth, mapped, req, res);
    if (!plugins.has("bearer")) return res;
    const token = sessionTokenOf(res.headers.getSetCookie());
    if (!token) return res;
    const out = new Response(res.body, res);
    out.headers.set("set-auth-token", token);
    out.headers.append("access-control-expose-headers", "set-auth-token");
    return out;
  };
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
