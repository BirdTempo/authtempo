import type { ResolvedConfig } from "../../config.js";
import {
  confirmAccountDelete,
  DELETE_TOKEN_RE,
  startAccountDelete,
} from "../../engine/account-delete.js";
import {
  confirmEmailChange,
  EMAIL_CHANGE_TOKEN_RE,
  requestEmailChange,
  verifyEmailChange,
} from "../../engine/email-change.js";
import { updateProfile } from "../../engine/profile.js";
import { readSessionToken } from "../../engine/sessions.js";
import { fail } from "../../result.js";
import { defaultAccountDeletePage } from "../account-delete-page.js";
import { isJsonRequest, readBody } from "../body.js";
import { changeBody, confirmBody, deleteBody, updateBody, verifyBody } from "../contract/user.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";
import { signedOut } from "./sessions.js";

/**
 * The user routes of a settings page (plan 12a). They exist in every
 * deployment, except the code verify (`emailOtp`) and the three delete
 * routes (`account.delete`).
 */
export function userRoutes(config: ResolvedConfig): Route[] {
  const confirmPath = `${config.basePath}/user/change-email/confirm`;
  // The appURL of the request's entry of baseURL (plan 12i Task 18).
  const failed = (ctx: RouteContext, code: string) => authErrorRedirect(ctx.config, code);
  const routes: Route[] = [
    {
      method: "POST",
      path: "/user/update",
      key: "POST /user/update",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, updateBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(await updateProfile(ctx.config, { session: s.resolved, ...body.value })),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/user/change-email",
      key: "POST /user/change-email",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, changeBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(await requestEmailChange(ctx.config, { session: s.resolved, ...body.value })),
          s.renewed,
        );
      },
    },
    {
      // A mail scanner or a link preview fetches this. It must change
      // nothing: no storage read, no limiter call, no cookie.
      method: "GET",
      path: "/user/change-email/confirm",
      key: "GET /user/change-email/confirm",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!EMAIL_CHANGE_TOKEN_RE.test(token)) return failed(ctx, "invalid_token");
        const html = ctx.config.account.confirmPage({
          action: confirmPath,
          token,
          appName: ctx.config.appName,
        });
        return new Response(html, {
          status: 200,
          headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
        });
      },
    },
    {
      method: "POST",
      path: "/user/change-email/confirm",
      key: "POST /user/change-email/confirm",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, confirmBody);
        // A form with no token is a client bug. The person sees the page of a bad link.
        if (!body.ok)
          return jsonCaller ? respond(fail("invalid_token")) : failed(ctx, "invalid_token");
        const r = await confirmEmailChange(ctx.config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return jsonCaller ? respond(r) : failed(ctx, r.code);
        if (jsonCaller) return json({ user: r.value.user });
        return redirect(resolveNext(ctx.config, r.value.next));
      },
    },
  ];
  if (config.emailOtp)
    routes.push({
      method: "POST",
      path: "/user/change-email/verify",
      key: "POST /user/change-email/verify",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await verifyEmailChange(ctx.config, {
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
  if (config.account.delete) {
    const deleteConfirmPath = `${config.basePath}/user/delete/confirm`;
    routes.push(
      {
        method: "POST",
        path: "/user/delete",
        key: "POST /user/delete",
        async handler(ctx) {
          const s = await withSession(ctx.config, ctx.request);
          if (!s) return unauthorized();
          const body = await readJson(ctx.request, deleteBody);
          if (!body.ok) return sent(respond(body), s.renewed);
          const r = await startAccountDelete(ctx.config, {
            session: s.resolved,
            ip: ctx.ip,
            userAgent: ctx.request.headers.get("user-agent"),
          });
          if (!r.ok) return sent(respond(r), s.renewed);
          // `account.deleteConfirm` on: a link went out, and the session stays.
          if ("sent" in r.value) return sent(json(r.value), s.renewed);
          // The session is gone: answer as the sign-out does, with no renewed cookie.
          return signedOut(ctx.config, ctx.request, readSessionToken(ctx.config, ctx.request));
        },
      },
      {
        // A mail scanner or a link preview fetches this. It must change
        // nothing: no storage read, no limiter call, no cookie.
        method: "GET",
        path: "/user/delete/confirm",
        key: "GET /user/delete/confirm",
        async handler(ctx) {
          const token = ctx.url.searchParams.get("token") ?? "";
          if (!DELETE_TOKEN_RE.test(token)) return failed(ctx, "invalid_token");
          const html = defaultAccountDeletePage({
            action: deleteConfirmPath,
            token,
            appName: ctx.config.appName,
          });
          return new Response(html, {
            status: 200,
            headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
          });
        },
      },
      {
        method: "POST",
        path: "/user/delete/confirm",
        key: "POST /user/delete/confirm",
        async handler(ctx) {
          const jsonCaller = isJsonRequest(ctx.request);
          const s = await withSession(ctx.config, ctx.request);
          if (!s) return jsonCaller ? unauthorized() : failed(ctx, "unauthorized");
          const body = await readBody(ctx.request, confirmBody);
          // A form with no token is a client bug. The person sees the page of a bad link.
          const r = body.ok
            ? await confirmAccountDelete(ctx.config, {
                session: s.resolved,
                token: body.value.token,
                ip: ctx.ip,
                userAgent: ctx.request.headers.get("user-agent"),
              })
            : fail("invalid_token");
          if (!r.ok) return sent(jsonCaller ? respond(r) : failed(ctx, r.code), s.renewed);
          // The session is gone: answer as the sign-out does, with no renewed cookie.
          const out = await signedOut(
            ctx.config,
            ctx.request,
            readSessionToken(ctx.config, ctx.request),
          );
          if (jsonCaller) return out;
          // A form lands on the app, with the same cleared cookies.
          const landed = redirect(`${ctx.config.appURL}/`);
          for (const cookie of out.headers.getSetCookie())
            landed.headers.append("set-cookie", cookie);
          return landed;
        },
      },
    );
  }
  return routes;
}
