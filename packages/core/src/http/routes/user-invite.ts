import type { ResolvedConfig } from "../../config.js";
import {
  publicSession,
  readModeOf,
  resolveSession,
  sessionMaxAgeSeconds,
} from "../../engine/sessions.js";
import { confirmUserInvite, USER_INVITE_TOKEN_RE } from "../../engine/user-invite.js";
import { fail } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import { inviteConfirmBody } from "../contract/user.js";
import { sessionCookie } from "../cookies.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, respond } from "../json.js";
import { authErrorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import {
  challengePageUrl,
  trustTokenOf,
  twoFactorJson,
  viaField,
  withLastMethod,
} from "../session-answer.js";

/**
 * The invitation link of a user that an operator created (plan 12f2 Task 3).
 * The routes exist with `operator.users` on, the config that lets an
 * operator create a user. The last method of the invitation is
 * `magic_link`: a mailed link proves the mailbox, and the sign-in page
 * then offers the magic link, the way back in without an operator.
 */
export function userInviteRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator?.users) return [];
  const confirmPath = `${config.basePath}/user/invite/confirm`;
  // The appURL of the request's entry of baseURL (plan 12i Task 18).
  const failed = (ctx: RouteContext, code: string) => authErrorRedirect(ctx.config, code);
  return [
    {
      // A mail scanner or link preview fetches this. It must change nothing:
      // no storage read, no limiter call, no cookie. The person presses the
      // button, and the browser posts the token to the route below.
      method: "GET",
      path: "/user/invite/confirm",
      key: "GET /user/invite/confirm",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!USER_INVITE_TOKEN_RE.test(token)) return failed(ctx, "invalid_token");
        const html = ctx.config.magicLink.confirmPage({
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
      path: "/user/invite/confirm",
      key: "POST /user/invite/confirm",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, inviteConfirmBody);
        // A body with no token is a client bug, not a user error: the empty
        // token fails the form check after the limit, so every POST counts,
        // and the person sees the same page they see for a bad link.
        const result = await confirmUserInvite(ctx.config, {
          token: body.ok ? body.value.token : "",
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(
            ctx.config,
            ctx.request,
            body.ok ? body.value.trustDevice : undefined,
          ),
        });
        if (!result.ok) return jsonCaller ? respond(result) : failed(ctx, result.code);
        // A user with the second factor on (plan 12c): no cookie. A form goes to the challenge page.
        if ("twoFactor" in result.value)
          return jsonCaller
            ? twoFactorJson(result.value)
            : redirect(challengePageUrl(ctx.config, result.value.twoFactor.challenge));
        const cookie = sessionCookie(
          ctx.config.cookieName,
          result.value.token,
          sessionMaxAgeSeconds(ctx.config),
          ctx.config.cookie.sameSite,
        );
        if (jsonCaller) {
          // The session row was created a moment ago; a null here is a
          // storage failure, and the token is spent. The person asks the
          // support for a new invitation or signs in by a magic link.
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
