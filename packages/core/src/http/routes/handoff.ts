import type { ResolvedConfig } from "../../config.js";
import {
  continueHandoff,
  continuePath,
  peekHandoff,
  redeemHandoff,
  startHandoff,
} from "../../engine/handoff.js";
import { publicSession, sessionFromRequest } from "../../engine/sessions.js";
import { readBody } from "../body.js";
import { continueBody, redeemBody } from "../contract/handoff.js";
import { confirmPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorRedirect, redirect } from "../redirect.js";
import type { Route } from "../router.js";
import { signInPageResponse } from "../sign-in-response.js";

export function handoffRoutes(config: ResolvedConfig): Route[] {
  const handoff = config.handoff;
  if (!handoff) return [];
  const page = (handoffId: string): Response =>
    signInPageResponse(config, continuePath(config, handoffId));
  const confirm = (handoffId: string, email: string, redirectTo: string): Response => {
    const html = handoff.confirmPage({
      action: `${config.basePath}/handoff/continue`,
      handoffId,
      email,
      redirect: redirectTo,
      appName: config.appName,
    });
    return new Response(html, {
      status: 200,
      headers: pageHeaders(config, confirmPagePolicy(config, redirectTo)),
    });
  };
  return [
    {
      method: "GET",
      path: "/handoff/start",
      key: "GET /handoff/start",
      async handler(ctx) {
        const r = await startHandoff(ctx.config, {
          challenge: ctx.url.searchParams.get("challenge") ?? "",
          redirect: ctx.url.searchParams.get("redirect") ?? "",
          ip: ctx.ip,
        });
        if (!r.ok) return respond(r);
        // A browser that already holds a session still sees the confirm page. A GET never mints a code.
        const session = await sessionFromRequest(ctx.config, ctx.request);
        if (session)
          return redirect(`${ctx.config.baseURL}${continuePath(ctx.config, r.value.handoffId)}`);
        return page(r.value.handoffId);
      },
    },
    {
      method: "GET",
      path: "/handoff/continue",
      key: "GET /handoff/continue",
      async handler(ctx) {
        const handoffId = ctx.url.searchParams.get("h") ?? "";
        // Never render a page for an id that is spent, expired, or unknown.
        const live = await peekHandoff(ctx.config, handoffId);
        if (!live.ok) return authErrorRedirect(ctx.config, live.code);
        const session = await sessionFromRequest(ctx.config, ctx.request);
        // No session yet: the person came back here before any sign-in
        // completed, so show the page again for the same handoff.
        if (!session) return page(handoffId);
        return confirm(handoffId, session.user.email, live.value.redirect);
      },
    },
    {
      method: "POST",
      path: "/handoff/continue",
      key: "POST /handoff/continue",
      async handler(ctx) {
        // Stricter than the router: the confirm page posts from baseURL only. A trusted app origin, or a sibling subdomain, must not be able to post this form, even with a SameSite=None cookie.
        const origin = ctx.request.headers.get("origin");
        if (origin !== ctx.config.baseURL) return json({ error: "origin_not_trusted" }, 403);
        const site = ctx.request.headers.get("sec-fetch-site");
        if (site !== null && site !== "same-origin")
          return json({ error: "origin_not_trusted" }, 403);
        const body = await readBody(ctx.request, continueBody);
        if (!body.ok) return authErrorRedirect(ctx.config, "invalid_token");
        const handoffId = body.value.h;
        // The same rule as the GET: no page for a spent, expired, or unknown id.
        const live = await peekHandoff(ctx.config, handoffId);
        if (!live.ok) return authErrorRedirect(ctx.config, live.code);
        const session = await sessionFromRequest(ctx.config, ctx.request);
        // No session: mint nothing, and show the sign-in page for this id.
        if (!session) return page(handoffId);
        const r = await continueHandoff(ctx.config, {
          handoffId,
          userId: session.user.id,
          sessionId: session.session.id,
        });
        return r.ok ? redirect(r.value.location) : authErrorRedirect(ctx.config, r.code);
      },
    },
    {
      method: "POST",
      path: "/handoff/redeem",
      key: "POST /handoff/redeem",
      async handler(ctx) {
        const body = await readJson(ctx.request, redeemBody);
        if (!body.ok) return respond(body);
        const r = await redeemHandoff(ctx.config, {
          code: body.value.code,
          verifier: body.value.verifier,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return respond(r);
        // A bearer answer: the app keeps the token. No cookie.
        return json({
          token: r.value.token,
          ...publicSession({ user: r.value.user, session: r.value.session, refreshed: false }),
        });
      },
    },
  ];
}
