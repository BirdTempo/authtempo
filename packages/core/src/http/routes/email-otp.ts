import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { anonymousCaller } from "../../engine/anonymous.js";
import {
  type EmailOtpSession,
  requestEmailOtp,
  requestResetOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
} from "../../engine/email-otp.js";
import type { LastMethod } from "../../engine/last-method.js";
import { requestBody, resetBody, verifyBody } from "../contract/email-otp.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import {
  signedInResponse,
  trustTokenOf,
  twoFactorJson,
  withLastMethod,
} from "../session-answer.js";

/**
 * The email code routes (plan 9e). None with `emailOtp: false`, and no reset
 * route without `password`, so the router answers 404. A verify and a reset
 * answer JSON with the session cookie, never a redirect: a browser keeps
 * the cookie, and a native app keeps the token.
 */
export function emailOtpRoutes(config: ResolvedConfig): Route[] {
  if (!config.emailOtp) return [];
  const signedIn = (v: EmailOtpSession, via?: LastMethod): Response =>
    signedInResponse(config, v, via);
  const routes: Route[] = [
    {
      method: "POST",
      path: "/otp/request",
      key: "POST /otp/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(
          await requestEmailOtp(ctx.config, {
            email: body.value.email,
            ip: ctx.ip,
            captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
            anonymous: await anonymousCaller(ctx.config, ctx.request),
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/otp/verify",
      key: "POST /otp/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyEmailOtp(ctx.config, {
          email: body.value.email,
          code: body.value.code,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
          anonymous: await anonymousCaller(ctx.config, ctx.request),
        });
        if (!r.ok) return respond(r);
        // A user with the second factor on: the challenge, and no cookie (plan 12c).
        if ("twoFactor" in r.value) return twoFactorJson(r.value);
        return withLastMethod(ctx.config, ctx.request, signedIn(r.value, "email_otp"), "email_otp");
      },
    },
  ];
  if (!config.password) return routes;
  return [
    ...routes,
    {
      method: "POST",
      path: "/otp/reset/request",
      key: "POST /otp/reset/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(
          await requestResetOtp(ctx.config, {
            email: body.value.email,
            ip: ctx.ip,
            captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/otp/reset",
      key: "POST /otp/reset",
      async handler(ctx) {
        const body = await readJson(ctx.request, resetBody);
        if (!body.ok) return respond(body);
        const r = await resetPasswordWithOtp(ctx.config, {
          email: body.value.email,
          code: body.value.code,
          password: body.value.password,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
        });
        if (!r.ok) return respond(r);
        // A user with the second factor on: the challenge, and no cookie (plan 12c).
        return "twoFactor" in r.value ? twoFactorJson(r.value) : signedIn(r.value);
      },
    },
  ];
}
