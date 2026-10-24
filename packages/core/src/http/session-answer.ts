import type { ResolvedConfig } from "../config.js";
import type { LastMethod } from "../engine/last-method.js";
import type { TwoFactorPending } from "../engine/second-factor.js";
import { publicSession, sessionMaxAgeSeconds } from "../engine/sessions.js";
import type { SessionRow, UserRow } from "../schema.js";
import { lastMethodCookie, readCookie, sessionCookie } from "./cookies.js";
import { json } from "./json.js";

/** The session cookie for `token`, with the config's name, lifetime, and SameSite. */
export function sessionCookieFor(config: ResolvedConfig, token: string): string {
  return sessionCookie(
    config.cookieName,
    token,
    sessionMaxAgeSeconds(config),
    config.cookie.sameSite,
  );
}

/**
 * `{ token, user, session }` with the session cookie, for the password and
 * the email code routes: a browser keeps the cookie, a native app keeps the
 * token. A sign-in passes its `via` (plan 12i Task 12); a reset passes none.
 */
export function signedInResponse(
  config: ResolvedConfig,
  v: { token: string; user: UserRow; session: SessionRow },
  via?: LastMethod,
): Response {
  return json(
    {
      token: v.token,
      ...publicSession({ user: v.user, session: v.session, refreshed: false }),
      ...viaField(config, via),
    },
    200,
    { "set-cookie": sessionCookieFor(config, v.token) },
  );
}

/**
 * The `via` of a JSON sign-in answer (plan 12i Task 12): the last method,
 * while `lastMethod` is on. A bearer client gets no readable cookie, so it
 * keeps this value itself. Empty with `lastMethod` off or with no method.
 */
export function viaField(
  config: ResolvedConfig,
  via: LastMethod | undefined,
): { via?: LastMethod } {
  return config.lastMethod && via !== undefined ? { via } : {};
}

/**
 * Appends the last method cookie to the answer of a browser sign-in (plan
 * 12i Task 12, spec 32 item 11). Nothing with `lastMethod` off. A request
 * with an `Authorization` header is a bearer client: it keeps the token and
 * reads `via`, so it gets no cookie. The cookie is a hint for the sign-in
 * page only: no read of core trusts it.
 */
export function withLastMethod(
  config: ResolvedConfig,
  request: Request,
  res: Response,
  method: LastMethod,
): Response {
  const last = config.lastMethod;
  if (!last || request.headers.has("authorization")) return res;
  res.headers.append("set-cookie", lastMethodCookie(last.cookieName, method, last.days * 86_400));
  return res;
}

/**
 * A challenge in place of a session, as JSON and with no cookie (plan 9f;
 * `methods` since plan 12c): the password sign-in, the reset, and the gated
 * sign-ins answer it, and the client calls `totp.verify` with the challenge.
 */
export function twoFactorJson(p: TwoFactorPending): Response {
  return json({
    twoFactor: {
      challenge: p.twoFactor.challenge,
      expiresAt: p.twoFactor.expiresAt.toISOString(),
      methods: p.twoFactor.methods,
    },
  });
}

/** The challenge page of a browser flow (plan 12c), on `baseURL`, as the challenge page's own redirect builds it (`routes/totp.ts`). */
export function challengePageUrl(config: ResolvedConfig, challenge: string): string {
  return `${config.baseURL}${config.basePath}/totp/challenge?challenge=${encodeURIComponent(challenge)}`;
}

/**
 * The trust token of a request (plan 9f). The body's token wins over the
 * cookie: a native app sends the body, a browser sends the cookie. `||`, not
 * `??`: an empty body value is no token, so the cookie still applies.
 */
export function trustTokenOf(
  config: ResolvedConfig,
  request: Request,
  fromBody: string | undefined,
): string | undefined {
  return (
    fromBody ||
    (config.totp ? (readCookie(request, config.totp.trustCookieName) ?? undefined) : undefined)
  );
}
