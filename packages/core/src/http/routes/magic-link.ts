import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { anonymousCaller } from "../../engine/anonymous.js";
import { MAGIC_LINK_TOKEN_RE, requestMagicLink, verifyMagicLink } from "../../engine/magic-link.js";
import {
  publicSession,
  readModeOf,
  resolveSession,
  sessionMaxAgeSeconds,
} from "../../engine/sessions.js";
import { fail } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import { requestBody, verifyBody } from "../contract/magic-link.js";
import { sessionCookie } from "../cookies.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import {
  challengePageUrl,
  trustTokenOf,
  twoFactorJson,
  viaField,
  withLastMethod,
} from "../session-answer.js";

export function magicLinkRoutes(config: ResolvedConfig): Route[] {
  const verifyPath = `${config.basePath}/magic-link/verify`;
  // The appURL of the request's entry of baseURL (plan 12i Task 18).
  const failed = (ctx: RouteContext, code: string) => authErrorRedirect(ctx.config, code);
  return [
    {
      method: "POST",
      path: "/magic-link/request",
      key: "POST /magic-link/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(
          await requestMagicLink(ctx.config, {
            email: body.value.email,
            next: body.value.next,
            ip: ctx.ip,
            captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
            anonymous: await anonymousCaller(ctx.config, ctx.request),
          }),
        );
      },
    },
    {
      // A mail scanner or link preview fetches this. It must change nothing:
      // no storage read, no limiter call, no cookie. The person presses the
      // button, and the browser posts the token to the route below.
      method: "GET",
      path: "/magic-link/verify",
      key: "GET /magic-link/verify",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!MAGIC_LINK_TOKEN_RE.test(token)) return failed(ctx, "invalid_token");
        const html = ctx.config.magicLink.confirmPage({
          action: verifyPath,
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
      path: "/magic-link/verify",
      key: "POST /magic-link/verify",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, verifyBody);
        // A form with no token is a client bug, not a user error. The
        // person sees the same page they see for a bad link.
        if (!body.ok)
          return jsonCaller ? respond(fail("invalid_token")) : failed(ctx, "invalid_token");
        const result = await verifyMagicLink(ctx.config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
          anonymous: await anonymousCaller(ctx.config, ctx.request),
        });
        if (!result.ok) return jsonCaller ? respond(result) : failed(ctx, result.code);
        // A user with the second factor on (plan 12c): no cookie. A form goes
        // to the challenge page, whose row holds the link's `next`.
        if ("twoFactor" in result.value)
          return jsonCaller
            ? twoFactorJson(result.value)
            : redirect(challengePageUrl(ctx.config, result.value.twoFactor.challenge));
        const maxAge = sessionMaxAgeSeconds(ctx.config);
        const cookie = sessionCookie(
          ctx.config.cookieName,
          result.value.token,
          maxAge,
          ctx.config.cookie.sameSite,
        );
        if (jsonCaller) {
          // One extra read, on the JSON path only. verifyMagicLink does not return the row.
          // The session row was created a moment ago; a null here is a storage failure, and the token is spent. The caller asks for a new link.
          const resolved = await resolveSession(
            ctx.config,
            result.value.token,
            readModeOf(ctx.config, ctx.request),
          );
          if (!resolved) return respond(fail("invalid_token"));
          return withLastMethod(
            ctx.config,
            ctx.request,
            json({ ...publicSession(resolved), ...viaField(ctx.config, "magic_link") }, 200, {
              "set-cookie": cookie,
            }),
            "magic_link",
          );
        }
        const res = redirect(resolveNext(ctx.config, result.value.next));
        res.headers.set("set-cookie", cookie);
        return withLastMethod(ctx.config, ctx.request, res, "magic_link");
      },
    },
  ];
}
