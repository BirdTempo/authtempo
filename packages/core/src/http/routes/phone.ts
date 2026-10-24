import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { anonymousCaller } from "../../engine/anonymous.js";
import {
  addPhone,
  type PhoneSession,
  removePhone,
  requestPhone,
  verifyAddPhone,
  verifyPhone,
} from "../../engine/phone.js";
import { addBody, addVerifyBody, removeBody, requestBody, verifyBody } from "../contract/phone.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import {
  signedInResponse,
  trustTokenOf,
  twoFactorJson,
  withLastMethod,
} from "../session-answer.js";
import { sent, unauthorized, withSession } from "../session-route.js";

/**
 * The phone routes (plan 12i Task 5, spec 32 item 5). They exist while
 * `phone` is on. The request and the verify need no session: the verify
 * answers JSON with the session cookie, as the email code does. The add,
 * its verify, and the remove need a fresh session.
 */
export function phoneRoutes(config: ResolvedConfig): Route[] {
  if (!config.phone) return [];
  const signedIn = (v: PhoneSession): Response => signedInResponse(config, v, "phone");
  return [
    {
      method: "POST",
      path: "/phone/request",
      key: "POST /phone/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        // The send runs after the answer, so the time tells no account (ruling 23 of plan 12i).
        return respond(
          await requestPhone(
            ctx.config,
            {
              phone: body.value.phone,
              ip: ctx.ip,
              captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
              anonymous: await anonymousCaller(ctx.config, ctx.request),
            },
            ctx.waitUntil,
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/phone/verify",
      key: "POST /phone/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyPhone(ctx.config, {
          phone: body.value.phone,
          code: body.value.code,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
          anonymous: await anonymousCaller(ctx.config, ctx.request),
        });
        if (!r.ok) return respond(r);
        // A user with the second factor on: the challenge, and no cookie (plan 12c).
        // The challenge row keeps the method `phone`, and its verify sets the cookie (plan 12i Task 12).
        if ("twoFactor" in r.value) return twoFactorJson(r.value);
        return withLastMethod(ctx.config, ctx.request, signedIn(r.value), "phone");
      },
    },
    {
      method: "POST",
      path: "/phone/add",
      key: "POST /phone/add",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, addBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await addPhone(ctx.config, {
              session: s.resolved,
              phone: body.value.phone,
              ip: ctx.ip,
            }),
          ),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/phone/add/verify",
      key: "POST /phone/add/verify",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, addVerifyBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await verifyAddPhone(ctx.config, {
              session: s.resolved,
              code: body.value.code,
              ip: ctx.ip,
              userAgent: ctx.request.headers.get("user-agent"),
            }),
          ),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/phone/remove",
      key: "POST /phone/remove",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, removeBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await removePhone(ctx.config, {
              session: s.resolved,
              ip: ctx.ip,
              userAgent: ctx.request.headers.get("user-agent"),
            }),
          ),
          s.renewed,
        );
      },
    },
  ];
}
