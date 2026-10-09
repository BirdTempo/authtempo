import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  continueHandoff,
  continuePath,
  redeemHandoff,
  startHandoff,
} from "../../engine/handoff.js";
import { publicSession, sessionFromRequest } from "../../engine/sessions.js";
import { randomBase64Url } from "../../primitives/crypto.js";
import { formAction, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect } from "../redirect.js";
import type { Route } from "../router.js";

const redeemBody = z.object({ code: z.string().max(64), verifier: z.string().min(43).max(128) });

export function handoffRoutes(config: ResolvedConfig): Route[] {
  const handoff = config.handoff;
  if (!handoff) return [];
  const methods = {
    magicLink: true as const,
    google: config.social.providers.some((p) => p.name === "google"),
    apple: config.social.providers.some((p) => p.name === "apple"),
    passkey: config.passkey !== null,
  };
  const page = (handoffId: string): Response => {
    const nonce = randomBase64Url(16);
    const html = handoff.signInPage({
      basePath: config.basePath,
      continuePath: continuePath(config, handoffId),
      methods,
      nonce,
    });
    const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action ${formAction(config)}; base-uri 'none'; frame-ancestors 'none'`;
    return new Response(html, { status: 200, headers: pageHeaders(config, policy) });
  };
  const continueFor = async (handoffId: string, userId: string): Promise<Response> => {
    const r = await continueHandoff(config, { handoffId, userId });
    return r.ok ? redirect(r.value.location) : redirect(authErrorUrl(config, r.code));
  };
  return [
    {
      method: "GET",
      path: "/handoff/start",
      async handler(ctx) {
        const r = await startHandoff(config, {
          challenge: ctx.url.searchParams.get("challenge") ?? "",
          redirect: ctx.url.searchParams.get("redirect") ?? "",
          ip: ctx.ip,
        });
        if (!r.ok) return respond(r);
        // A browser that already holds a session needs no page.
        const session = await sessionFromRequest(config, ctx.request);
        if (session) return continueFor(r.value.handoffId, session.user.id);
        return page(r.value.handoffId);
      },
    },
    {
      method: "GET",
      path: "/handoff/continue",
      async handler(ctx) {
        const handoffId = ctx.url.searchParams.get("h") ?? "";
        const session = await sessionFromRequest(config, ctx.request);
        // No session yet: the person came back here before any sign-in
        // completed, so show the page again for the same handoff.
        if (!session) return page(handoffId);
        return continueFor(handoffId, session.user.id);
      },
    },
    {
      method: "POST",
      path: "/handoff/redeem",
      async handler(ctx) {
        const body = await readJson(ctx.request, redeemBody);
        if (!body.ok) return respond(body);
        const r = await redeemHandoff(config, {
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
