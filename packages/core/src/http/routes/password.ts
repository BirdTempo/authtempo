import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import {
  changePassword,
  PASSWORD_RESET_TOKEN_RE,
  PASSWORD_VERIFY_TOKEN_RE,
  type PasswordSession,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resendPasswordVerification,
  resetPassword,
  verifyPasswordEmail,
} from "../../engine/password.js";
import { PASSWORD_MAX_LENGTH } from "../../engine/password-policy.js";
import { publicUser, renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { fail } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import {
  changeBody,
  RESET_PAGE_ERRORS,
  resendBody,
  resetBody,
  resetRequestBody,
  signInBody,
  signUpBody,
  tokenBody,
} from "../contract/password.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { defaultPasswordVerifyPage, type ResetPageInput } from "../password-pages.js";
import { authErrorRedirect, errorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route } from "../router.js";
import {
  challengePageUrl,
  sessionCookieFor,
  signedInResponse,
  trustTokenOf,
  twoFactorJson,
} from "../session-answer.js";

type PageError = NonNullable<ResetPageInput["error"]>;

/** The refusals the reset page shows, from the contract (one source). The link is still valid after each. */
const PAGE_ERRORS: ReadonlySet<string> = new Set<PageError>(RESET_PAGE_ERRORS);

/** A guard, not a cast: a code outside `PAGE_ERRORS` stays a string. */
function isPageError(code: string | null): code is PageError {
  return code !== null && PAGE_ERRORS.has(code);
}

/** No route without a `password` config, so the router answers 404. */
export function passwordRoutes(config: ResolvedConfig): Route[] {
  if (!config.password) return [];
  const pw = config.password;
  const verifyPath = `${config.basePath}/password/verify`;
  const resetPath = `${config.basePath}/password/reset`;
  const failed = (code: string) => authErrorRedirect(config, code);
  const page = (html: string) =>
    new Response(html, { status: 200, headers: pageHeaders(config, noScriptPagePolicy(config)) });
  const cookieFor = (token: string) => sessionCookieFor(config, token);
  const signedIn = (v: PasswordSession): Response => signedInResponse(config, v);
  return [
    {
      method: "POST",
      path: "/password/sign-up",
      key: "POST /password/sign-up",
      async handler(ctx) {
        const body = await readJson(ctx.request, signUpBody);
        if (!body.ok) return respond(body);
        const r = await passwordSignUp(ctx.config, {
          email: body.value.email,
          password: body.value.password,
          name: body.value.name,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
        });
        if (!r.ok) return respond(r);
        // The uniform answer (plan 12b): the same bytes for every address, no cookie.
        if ("sent" in r.value) return json({ sent: true });
        // password.requireVerified with uniformSignUp off (plan 12b): the user, no session, and no cookie.
        if ("verifyRequired" in r.value)
          return json({ user: publicUser(r.value.user), verifyRequired: true });
        return signedIn(r.value);
      },
    },
    {
      method: "POST",
      path: "/password/sign-in",
      key: "POST /password/sign-in",
      async handler(ctx) {
        const body = await readJson(ctx.request, signInBody);
        if (!body.ok) return respond(body);
        const r = await passwordSignIn(ctx.config, {
          email: body.value.email,
          password: body.value.password,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
          next: body.value.next,
          captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
        });
        if (!r.ok) return respond(r);
        // A user with a second factor (plan 9f): the challenge, and no cookie.
        if ("twoFactor" in r.value) return twoFactorJson(r.value);
        return signedIn(r.value);
      },
    },
    {
      // A mail scanner fetches this. It must change nothing: no storage
      // read, no limiter call, no cookie. The person presses the button.
      method: "GET",
      path: "/password/verify",
      key: "GET /password/verify",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!PASSWORD_VERIFY_TOKEN_RE.test(token)) return failed("invalid_token");
        return page(
          defaultPasswordVerifyPage({ action: verifyPath, token, appName: ctx.config.appName }),
        );
      },
    },
    {
      method: "POST",
      path: "/password/verify",
      key: "POST /password/verify",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, tokenBody);
        // A form with no token is a client bug. The person sees the page for a bad link.
        if (!body.ok) return jsonCaller ? respond(fail("invalid_token")) : failed("invalid_token");
        const r = await verifyPasswordEmail(ctx.config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return jsonCaller ? respond(r) : failed(r.code);
        const res = jsonCaller ? json({ verified: true }) : redirect(resolveNext(ctx.config, "/"));
        if (r.value.signedIn) res.headers.set("set-cookie", cookieFor(r.value.signedIn.token));
        return res;
      },
    },
    {
      // A new verify link (plan 8b). No session: the person may have none.
      method: "POST",
      path: "/password/verify/resend",
      key: "POST /password/verify/resend",
      async handler(ctx) {
        const body = await readJson(ctx.request, resendBody);
        if (!body.ok) return respond(body);
        return respond(
          await resendPasswordVerification(ctx.config, { email: body.value.email, ip: ctx.ip }),
        );
      },
    },
    {
      method: "POST",
      path: "/password/reset/request",
      key: "POST /password/reset/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, resetRequestBody);
        if (!body.ok) return respond(body);
        return respond(
          await requestPasswordReset(ctx.config, {
            email: body.value.email,
            next: body.value.next,
            ip: ctx.ip,
            captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
          }),
        );
      },
    },
    {
      // A mail scanner fetches this too. No storage read, no cookie.
      method: "GET",
      path: "/password/reset",
      key: "GET /password/reset",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!PASSWORD_RESET_TOKEN_RE.test(token)) return failed("invalid_token");
        const raw = ctx.url.searchParams.get("error");
        const error = isPageError(raw) ? raw : null;
        return page(
          pw.resetPage({
            action: resetPath,
            token,
            appName: ctx.config.appName,
            minLength: pw.minLength,
            maxLength: PASSWORD_MAX_LENGTH,
            error,
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/password/reset",
      key: "POST /password/reset",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, resetBody);
        if (!body.ok) return jsonCaller ? respond(fail("invalid_token")) : failed("invalid_token");
        const r = await resetPassword(ctx.config, {
          token: body.value.token,
          password: body.value.password,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
        });
        if (!r.ok) {
          if (jsonCaller) return respond(r);
          // The link is still valid after a refused password: send the person back to the form.
          if (isPageError(r.code))
            return errorRedirect(
              `${ctx.config.baseURL}${resetPath}?token=${encodeURIComponent(body.value.token)}&error=${r.code}`,
              r.code,
            );
          return failed(r.code);
        }
        // The factor is on (plan 12c, owner decision 1 of 2026-10-14): no
        // cookie. JSON answers the challenge; a form goes to the challenge
        // page, whose row holds the link's `next`. 302, as every form route.
        if ("twoFactor" in r.value)
          return jsonCaller
            ? twoFactorJson(r.value)
            : redirect(challengePageUrl(ctx.config, r.value.twoFactor.challenge));
        if (jsonCaller) return signedIn(r.value);
        const res = redirect(resolveNext(ctx.config, r.value.next));
        res.headers.set("set-cookie", cookieFor(r.value.token));
        return res;
      },
    },
    {
      method: "POST",
      path: "/password/change",
      key: "POST /password/change",
      async handler(ctx) {
        const resolved = await sessionFromRequest(ctx.config, ctx.request);
        if (!resolved) return json({ error: "unauthorized" }, 401);
        const renewed = renewedSessionCookie(ctx.config, ctx.request, resolved);
        const body = await readJson(ctx.request, changeBody);
        const res = body.ok
          ? respond(
              await changePassword(ctx.config, {
                session: resolved,
                currentPassword: body.value.currentPassword,
                newPassword: body.value.newPassword,
                // For the notice mail (plan 12a).
                ip: ctx.ip,
                userAgent: ctx.request.headers.get("user-agent"),
              }),
            )
          : respond(body);
        if (renewed) res.headers.append("set-cookie", renewed);
        return res;
      },
    },
  ];
}
