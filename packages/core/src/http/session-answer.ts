import type { ResolvedConfig } from "../config.js";
import type { LastMethod } from "../engine/last-method.js";
import { bagAtSignIn, bagTokens } from "../engine/multi-session.js";
import type { TwoFactorPending } from "../engine/second-factor.js";
import { publicSession, sessionCookieToken, sessionMaxAgeSeconds } from "../engine/sessions.js";
import { isBearerRequest } from "../primitives/credentials.js";
import type { SessionRow, UserRow } from "../schema.js";
import {
  bagCookie,
  clearBagCookie,
  lastMethodCookie,
  readCookie,
  sessionCookie,
} from "./cookies.js";
import { actorCookieName } from "./impersonation-rules.js";
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
 * `extra` adds the members of one flow: the sign-up proof of a sign-up, and
 * `passwordKept` of a sign-up confirm (ruling 11 of plan 12q).
 */
export function signedInResponse(
  config: ResolvedConfig,
  v: { token: string; user: UserRow; session: SessionRow },
  via?: LastMethod,
  extra: { signUpProof?: string; passwordKept?: boolean } = {},
): Response {
  return json(
    {
      token: v.token,
      ...publicSession({ user: v.user, session: v.session, refreshed: false }),
      ...viaField(config, via),
      ...extra,
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
 * with the Bearer scheme is a bearer client (`isBearerRequest`): it keeps
 * the token and reads `via`, so it gets no cookie. The cookie is a hint for the sign-in
 * page only: no read of core trusts it.
 */
export function withLastMethod(
  config: ResolvedConfig,
  request: Request,
  res: Response,
  method: LastMethod,
): Response {
  const last = config.lastMethod;
  if (!last || isBearerRequest(request)) return res;
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

/** The token that a Set-Cookie of `res` writes to `name`, or null. A clear writes none. */
function cookieSet(res: Response, name: string): string | null {
  const set = res.headers.getSetCookie().findLast((c) => c.startsWith(`${name}=`));
  const value = set?.slice(name.length + 1).split(";")[0] ?? "";
  return value === "" ? null : value;
}

/**
 * Appends the bag cookie to `res` when the bag changed (plan 12i Task 11):
 * the tokens of `after`, or a clear when `after` is empty. `before` is the
 * value of the request's bag cookie, so a value that the read cut short or
 * cleaned is written again too.
 */
export function withBag(
  config: ResolvedConfig,
  res: Response,
  before: string | null,
  after: readonly string[],
): Response {
  const ms = config.multiSession;
  if (!ms) return res;
  if (after.length === 0 ? before === null : before === after.join(".")) return res;
  res.headers.append(
    "set-cookie",
    after.length === 0
      ? clearBagCookie(ms.cookieName, config.cookie.sameSite)
      : bagCookie(ms.cookieName, after, sessionMaxAgeSeconds(config), config.cookie.sameSite),
  );
  return res;
}

/**
 * The bag write at each browser sign-in (plan 12i Task 11). The router
 * calls it after every handler, so each route that sets a new session
 * cookie writes the bag through this one step: a new sign-in route cannot
 * skip it. It does nothing with multi-session off, for a request with the
 * Bearer scheme (`isBearerRequest`: a bearer client has no bag), during an
 * impersonation (the actor cookie holds the operator's token), and for an
 * answer that writes the bag cookie itself (the multi-session routes). A
 * renewal sets the same token, so it changes nothing.
 */
export async function withSessionBag(
  config: ResolvedConfig,
  request: Request,
  res: Response,
): Promise<Response> {
  const ms = config.multiSession;
  if (!ms || isBearerRequest(request)) return res;
  if (readCookie(request, actorCookieName(config)) !== null) return res;
  if (res.headers.getSetCookie().some((c) => c.startsWith(`${ms.cookieName}=`))) return res;
  const token = cookieSet(res, config.cookieName);
  const previous = sessionCookieToken(config, request);
  if (token === null || token === previous) return res;
  const raw = readCookie(request, ms.cookieName);
  // A first sign-in in the browser: no session to move and no bag, so no read.
  if (previous === null && raw === null) return res;
  const after = await bagAtSignIn(config, { previous, token, bag: bagTokens(config, raw) });
  return after === null ? res : withBag(config, res, raw, after);
}
