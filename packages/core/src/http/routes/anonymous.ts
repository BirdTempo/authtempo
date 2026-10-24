import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { deleteAnonymous, signInAnonymous } from "../../engine/anonymous.js";
import { readSessionToken } from "../../engine/sessions.js";
import { deleteBody, signInBody } from "../contract/anonymous.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { signedInResponse } from "../session-answer.js";
import { sent, unauthorized, withSession } from "../session-route.js";
import { signedOut } from "./sessions.js";

/**
 * The anonymous routes (plan 12i Task 6, spec 32 item 8). They exist while
 * `anonymous` is on. The sign-in answers JSON with the session cookie, as
 * the email code does. The delete needs the anonymous session and no fresh
 * one: that session is the only key of the user.
 */
export function anonymousRoutes(config: ResolvedConfig): Route[] {
  if (!config.anonymous) return [];
  return [
    {
      method: "POST",
      path: "/anonymous/sign-in",
      key: "POST /anonymous/sign-in",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        const token = readSessionToken(ctx.config, ctx.request);
        const body = await readJson(ctx.request, signInBody);
        if (!body.ok) return sent(respond(body), s?.renewed ?? null);
        const r = await signInAnonymous(ctx.config, {
          current: s && token !== null ? { session: s.resolved, token } : null,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
        });
        if (!r.ok) return sent(respond(r), s?.renewed ?? null);
        return signedInResponse(ctx.config, r.value);
      },
    },
    {
      method: "POST",
      path: "/anonymous/delete",
      key: "POST /anonymous/delete",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, deleteBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        const r = await deleteAnonymous(ctx.config, { session: s.resolved });
        if (!r.ok) return sent(respond(r), s.renewed);
        // The session is gone: answer as the sign-out does, with no renewed cookie.
        return signedOut(ctx.config, ctx.request, readSessionToken(ctx.config, ctx.request));
      },
    },
  ];
}
