import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  type EmailOtpSession,
  requestEmailOtp,
  requestResetOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
} from "../../engine/email-otp.js";
import { publicSession } from "../../engine/sessions.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";

const requestBody = z.object({ email: z.string().max(320) });
const verifyBody = z.object({ email: z.string().max(320), code: z.string().max(16) });
const resetBody = z.object({
  email: z.string().max(320),
  code: z.string().max(16),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
});

/**
 * The email code routes (plan 9e). None with `emailOtp: false`, and no reset
 * route without `password`, so the router answers 404. A verify and a reset
 * answer JSON with the session cookie, never a redirect: a browser keeps
 * the cookie, and a native app keeps the token.
 */
export function emailOtpRoutes(config: ResolvedConfig): Route[] {
  if (!config.emailOtp) return [];
  const signedIn = (v: EmailOtpSession): Response =>
    json(
      { token: v.token, ...publicSession({ user: v.user, session: v.session, refreshed: false }) },
      200,
      {
        "set-cookie": sessionCookie(
          config.cookieName,
          v.token,
          config.session.ttlDays * 86_400,
          config.cookie.sameSite,
        ),
      },
    );
  const routes: Route[] = [
    {
      method: "POST",
      path: "/otp/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(await requestEmailOtp(config, { email: body.value.email, ip: ctx.ip }));
      },
    },
    {
      method: "POST",
      path: "/otp/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyEmailOtp(config, {
          email: body.value.email,
          code: body.value.code,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        return r.ok ? signedIn(r.value) : respond(r);
      },
    },
  ];
  if (!config.password) return routes;
  return [
    ...routes,
    {
      method: "POST",
      path: "/otp/reset/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(await requestResetOtp(config, { email: body.value.email, ip: ctx.ip }));
      },
    },
    {
      method: "POST",
      path: "/otp/reset",
      async handler(ctx) {
        const body = await readJson(ctx.request, resetBody);
        if (!body.ok) return respond(body);
        const r = await resetPasswordWithOtp(config, {
          email: body.value.email,
          code: body.value.code,
          password: body.value.password,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        return r.ok ? signedIn(r.value) : respond(r);
      },
    },
  ];
}
