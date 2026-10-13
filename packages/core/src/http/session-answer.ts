import type { ResolvedConfig } from "../config.js";
import { publicSession } from "../engine/sessions.js";
import type { SessionRow, UserRow } from "../schema.js";
import { sessionCookie } from "./cookies.js";
import { json } from "./json.js";

/** The session cookie for `token`, with the config's name, lifetime, and SameSite. */
export function sessionCookieFor(config: ResolvedConfig, token: string): string {
  return sessionCookie(
    config.cookieName,
    token,
    config.session.ttlDays * 86_400,
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
