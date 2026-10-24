import type { ResolvedConfig } from "../../config.js";
import { bagTokens, signOutBrowser } from "../../engine/multi-session.js";
import { deliverLogouts } from "../../engine/oauth-logout.js";
import { listSessions, revokeOtherSessions, revokeSession } from "../../engine/session-list.js";
import {
  destroySession,
  publicSession,
  readModeOf,
  readSessionToken,
  renewedSessionCookie,
  resolveSession,
} from "../../engine/sessions.js";
import { revokeBody } from "../contract/sessions.js";
import { clearBagCookie, clearSessionCookie, readCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

/**
 * The answer of a request that ended the caller's session: the sign-out, the
 * revoke of the caller's own id, and the account delete (plan 12a). `token` is the session that the request
 * ended. It clears the cookie. The cookie move of plan 12b needs more: with
 * both names, the router keeps the old cookie, and `token` is the new one. So
 * the old token's session ends too, and the old name is cleared. Else the next
 * request signs in again under it. A sibling subdomain can set `tempo_session` too.
 */
export async function signedOut(
  config: ResolvedConfig,
  request: Request,
  token: string | null,
  body: Readonly<Record<string, unknown>> = { ok: true },
): Promise<Response> {
  return clearSessionCookies(config, request, token, json(body));
}

/**
 * Clears the session cookie on `res`, and with the cookie move of plan 12b
 * ends and clears the old cookie too (see `signedOut`). The end-session
 * route of plan 12e answers a page or a redirect, so it calls this alone.
 */
export async function clearSessionCookies(
  config: ResolvedConfig,
  request: Request,
  token: string | null,
  res: Response,
): Promise<Response> {
  res.headers.append("set-cookie", clearSessionCookie(config.cookieName, config.cookie.sameSite));
  const legacy = config.legacyCookieName;
  const old = legacy === null ? null : readCookie(request, legacy);
  if (legacy !== null && old !== null) {
    if (old !== token) {
      const ended = await destroySession(config, old);
      if (ended) await deliverLogouts(config, ended.userId);
    }
    res.headers.append("set-cookie", clearSessionCookie(legacy, config.cookie.sameSite));
  }
  return res;
}

/**
 * The answer of `GET /session` and `POST /session/refresh` (plan 12a).
 * `readModeOf` decides the mode: with `session.deferRefresh` on, the GET
 * writes nothing and answers `needsRefresh`, and the POST slides the expiry.
 */
async function sessionAnswer(config: ResolvedConfig, request: Request): Promise<Response> {
  const token = readSessionToken(config, request);
  const resolved = token ? await resolveSession(config, token, readModeOf(config, request)) : null;
  if (!resolved) {
    // A dead cookie is cleared, so the browser stops sending it.
    const hadCookie = readCookie(request, config.cookieName) !== null;
    const headers: Record<string, string> = hadCookie
      ? { "set-cookie": clearSessionCookie(config.cookieName, config.cookie.sameSite) }
      : {};
    return json({ error: "unauthorized" }, 401, headers);
  }
  // A sliding refresh moved the expiry. Renew the cookie, or the
  // browser drops it at its old Max-Age. A read-only read renews nothing.
  const renewed = renewedSessionCookie(config, request, resolved);
  // Only a read-only read sets needsRefresh, so the key off keeps the old answer.
  const body =
    resolved.needsRefresh === undefined
      ? publicSession(resolved)
      : { ...publicSession(resolved), needsRefresh: resolved.needsRefresh };
  return json(body, 200, renewed ? { "set-cookie": renewed } : {});
}

export function sessionRoutes(_config: ResolvedConfig): Route[] {
  return [
    {
      method: "GET",
      path: "/session",
      key: "GET /session",
      handler: (ctx) => sessionAnswer(ctx.config, ctx.request),
    },
    {
      // On with the key on or off (plan 12a): a client may post it in any deployment.
      method: "POST",
      path: "/session/refresh",
      key: "POST /session/refresh",
      handler: (ctx) => sessionAnswer(ctx.config, ctx.request),
    },
    {
      method: "POST",
      path: "/sign-out",
      key: "POST /sign-out",
      async handler(ctx) {
        const token = readSessionToken(ctx.config, ctx.request);
        // After the commit: the back-channel logouts of the session (plan 12e Task 16).
        const ended = token ? await destroySession(ctx.config, token) : null;
        if (ended) await deliverLogouts(ctx.config, ended.userId);
        const res = await signedOut(ctx.config, ctx.request, token);
        // Multi-session (plan 12i, owner decision 4): the sign-out ends every
        // session of the browser, so the sessions of the bag end too.
        const ms = ctx.config.multiSession;
        if (!ms) return res;
        await signOutBrowser(
          ctx.config,
          bagTokens(ctx.config, readCookie(ctx.request, ms.cookieName)),
        );
        res.headers.append("set-cookie", clearBagCookie(ms.cookieName, ctx.config.cookie.sameSite));
        return res;
      },
    },
    {
      method: "GET",
      path: "/sessions",
      key: "GET /sessions",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const r = await listSessions(ctx.config, { session: s.resolved });
        return sent(r.ok ? json({ sessions: r.value }) : respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/sessions/revoke",
      key: "POST /sessions/revoke",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, revokeBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        const r = await revokeSession(ctx.config, { session: s.resolved, id: body.value.id });
        if (!r.ok) return sent(respond(r), s.renewed);
        // The caller ended its own session: answer as the sign-out does
        // (review M1). The router does not clear the old name when the
        // request carries both names, so `signedOut` does it. `current`
        // tells a bearer client that its token ended (plan 12a Task 13 L1).
        if (r.value.current)
          return signedOut(ctx.config, ctx.request, readSessionToken(ctx.config, ctx.request), {
            ok: true,
            current: true,
          });
        return sent(json({ ok: true, current: false }), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/sessions/revoke-others",
      key: "POST /sessions/revoke-others",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        return sent(
          respond(await revokeOtherSessions(ctx.config, { session: s.resolved })),
          s.renewed,
        );
      },
    },
  ];
}
