import type { ResolvedConfig } from "../config.js";
import type { TwoFactorPending } from "../engine/second-factor.js";
import { publicSession, sessionMaxAgeSeconds } from "../engine/sessions.js";
import type { SessionRow, UserRow } from "../schema.js";
import { readCookie, sessionCookie } from "./cookies.js";
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
 * token.
 */
export function signedInResponse(
  config: ResolvedConfig,
  v: { token: string; user: UserRow; session: SessionRow },
): Response {
  return json(
    { token: v.token, ...publicSession({ user: v.user, session: v.session, refreshed: false }) },
    200,
    { "set-cookie": sessionCookieFor(config, v.token) },
  );
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
