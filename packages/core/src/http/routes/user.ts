import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  confirmEmailChange,
  EMAIL_CHANGE_TOKEN_RE,
  requestEmailChange,
  verifyEmailChange,
} from "../../engine/email-change.js";
import { updateProfile } from "../../engine/profile.js";
import { fail } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect, resolveNext } from "../redirect.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

const updateBody = z.strictObject({
  // The engine applies the name and image rules; these caps bound the body.
  name: z.string().max(400).nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
});
const changeBody = z.strictObject({
  // The engine normalizes the address; the cap bounds the body.
  newEmail: z.string().max(320),
  method: z.enum(["link", "code"]).optional(),
  next: z.string().max(2048).optional(),
});
// Not strict: a form may carry the name of its button.
const confirmBody = z.object({ token: z.string().max(64) });
const verifyBody = z.strictObject({ code: z.string().min(1).max(16) });

/** The user routes of a settings page (plan 12a). They exist in every deployment, except the code verify. */
export function userRoutes(config: ResolvedConfig): Route[] {
  const confirmPath = `${config.basePath}/user/change-email/confirm`;
  const failed = (code: string) => redirect(authErrorUrl(config, code));
  const routes: Route[] = [
    {
      method: "POST",
      path: "/user/update",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, updateBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(await updateProfile(config, { session: s.resolved, ...body.value })),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/user/change-email",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, changeBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(await requestEmailChange(config, { session: s.resolved, ...body.value })),
          s.renewed,
        );
      },
    },
    {
      // A mail scanner or a link preview fetches this. It must change
      // nothing: no storage read, no limiter call, no cookie.
      method: "GET",
      path: "/user/change-email/confirm",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!EMAIL_CHANGE_TOKEN_RE.test(token)) return failed("invalid_token");
        const html = config.account.confirmPage({
          action: confirmPath,
          token,
          appName: config.appName,
        });
        return new Response(html, {
          status: 200,
          headers: pageHeaders(config, noScriptPagePolicy(config)),
        });
      },
    },
    {
      method: "POST",
      path: "/user/change-email/confirm",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, confirmBody);
        // A form with no token is a client bug. The person sees the page of a bad link.
        if (!body.ok) return jsonCaller ? respond(fail("invalid_token")) : failed("invalid_token");
        const r = await confirmEmailChange(config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return jsonCaller ? respond(r) : failed(r.code);
        if (jsonCaller) return json({ user: r.value.user });
        return redirect(resolveNext(config, r.value.next));
      },
    },
  ];
  if (config.emailOtp)
    routes.push({
      method: "POST",
      path: "/user/change-email/verify",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await verifyEmailChange(config, {
              session: s.resolved,
              code: body.value.code,
              ip: ctx.ip,
              userAgent: ctx.request.headers.get("user-agent"),
            }),
          ),
          s.renewed,
        );
      },
    });
  return routes;
}
