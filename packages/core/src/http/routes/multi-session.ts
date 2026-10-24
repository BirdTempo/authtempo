import type { ResolvedConfig } from "../../config.js";
import {
  type BagEntry,
  bagTokens,
  listBrowserSessions,
  MULTI_SESSION_PER_IP,
  signOutOne,
  switchSession,
} from "../../engine/multi-session.js";
import {
  publicSession,
  type ResolvedSession,
  readModeOf,
  sessionCookieToken,
} from "../../engine/sessions.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import { isBearerRequest } from "../../primitives/credentials.js";
import { fail } from "../../result.js";
import { sessionIdBody } from "../contract/multi-session.js";
import { readCookie, sessionCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";
import { withBag } from "../session-answer.js";
import { sent, unauthorized, withSession } from "../session-route.js";
import { clearSessionCookies } from "./sessions.js";

/** The browser of a multi-session request: the active session, its token, and the bag. */
interface Browser {
  resolved: ResolvedSession;
  renewed: string | null;
  token: string;
  bag: string[];
  /** The value of the bag cookie, or null. */
  raw: string | null;
}

/**
 * The browser of the request, or the answer that refuses it. A request
 * with the Bearer scheme answers 401: a bearer client has no bag (spec 32
 * item 17). Another scheme, such as HTTP Basic, leaves a browser. Then the per-IP limit, then the active session of the
 * cookie. A bag token alone signs no request in.
 */
async function browserOf(ctx: RouteContext, bagName: string): Promise<Browser | Response> {
  if (isBearerRequest(ctx.request)) return unauthorized();
  if (!(await limit(ctx.config, "multi-session:ip", ipKey(ctx.ip), MULTI_SESSION_PER_IP)))
    return respond(fail("rate_limited"));
  const token = sessionCookieToken(ctx.config, ctx.request);
  const s = token === null ? null : await withSession(ctx.config, ctx.request);
  if (!s || token === null) return unauthorized();
  const raw = readCookie(ctx.request, bagName);
  return { ...s, token, raw, bag: bagTokens(ctx.config, raw) };
}

/** One session of the list: no token, and only the public fields of its user. */
function listed(resolved: ResolvedSession, active: boolean) {
  const { user } = resolved;
  return {
    sessionId: resolved.session.id,
    active,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      image: user.image,
    },
  };
}

/** The session cookie of a bag session that becomes active, with the life of its row. */
function activeCookie(config: ResolvedConfig, entry: BagEntry): string {
  const ms = entry.resolved.session.expiresAt.getTime() - config.clock.now().getTime();
  return sessionCookie(
    config.cookieName,
    entry.token,
    Math.max(0, Math.floor(ms / 1000)),
    config.cookie.sameSite,
  );
}

/**
 * The multi-session routes (plan 12i Task 11, spec 32 item 11). They exist
 * while `multiSession` is on. Each reads the browser's cookies only, and
 * each answer that changes the bag writes it again. The Origin rules of the
 * router guard the two POST routes, as every POST.
 */
export function multiSessionRoutes(config: ResolvedConfig): Route[] {
  const ms = config.multiSession;
  if (!ms) return [];
  return [
    {
      method: "GET",
      path: "/multi-session",
      key: "GET /multi-session",
      async handler(ctx) {
        const b = await browserOf(ctx, ms.cookieName);
        if (b instanceof Response) return b;
        const entries = await listBrowserSessions(ctx.config, {
          active: b.resolved,
          bag: b.bag,
          mode: readModeOf(ctx.config, ctx.request),
        });
        const res = json({
          sessions: [listed(b.resolved, true), ...entries.map((e) => listed(e.resolved, false))],
        });
        return withBag(
          ctx.config,
          sent(res, b.renewed),
          b.raw,
          entries.map((e) => e.token),
        );
      },
    },
    {
      method: "POST",
      path: "/multi-session/switch",
      key: "POST /multi-session/switch",
      async handler(ctx) {
        const b = await browserOf(ctx, ms.cookieName);
        if (b instanceof Response) return b;
        const body = await readJson(ctx.request, sessionIdBody);
        if (!body.ok) return sent(respond(body), b.renewed);
        const r = await switchSession(ctx.config, {
          active: b.resolved,
          activeToken: b.token,
          bag: b.bag,
          sessionId: body.value.sessionId,
          mode: "write",
        });
        if (!r.ok) return sent(respond(r), b.renewed);
        const res = json(publicSession(r.value.active.resolved));
        if (r.value.active.token === b.token) sent(res, b.renewed);
        else res.headers.append("set-cookie", activeCookie(ctx.config, r.value.active));
        return withBag(ctx.config, res, b.raw, r.value.bag);
      },
    },
    {
      method: "POST",
      path: "/multi-session/sign-out",
      key: "POST /multi-session/sign-out",
      async handler(ctx) {
        const b = await browserOf(ctx, ms.cookieName);
        if (b instanceof Response) return b;
        const body = await readJson(ctx.request, sessionIdBody);
        if (!body.ok) return sent(respond(body), b.renewed);
        const r = await signOutOne(ctx.config, {
          active: b.resolved,
          activeToken: b.token,
          bag: b.bag,
          sessionId: body.value.sessionId,
          mode: "write",
        });
        if (!r.ok) return sent(respond(r), b.renewed);
        if (r.value.ended === "bag")
          return withBag(ctx.config, sent(json({ ok: true }), b.renewed), b.raw, r.value.bag);
        // The active session ended: the first live bag session takes its place, or none.
        const res = json({ ok: true });
        const { next } = r.value;
        if (next) res.headers.append("set-cookie", activeCookie(ctx.config, next));
        else await clearSessionCookies(ctx.config, ctx.request, b.token, res);
        return withBag(ctx.config, res, b.raw, r.value.bag);
      },
    },
  ];
}
