import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  disableMethod,
  enableEmailMethod,
  enablePasskeyMethod,
  passkeyChallengeOptions,
  sendSecondFactorEmail,
} from "../../engine/second-factor-methods.js";
import {
  type ResolvedSession,
  renewedSessionCookie,
  sessionFromRequest,
} from "../../engine/sessions.js";
import { clearTrustCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

/** The sign-in's length bound applies in `checkUserPassword`; this cap only bounds the body. */
const passwordField = z.string().max(1024);
const passwordBody = z.object({ password: passwordField });
const passkeyEnableBody = z.object({ password: passwordField, response: z.unknown() });
const disableBody = z.object({ method: z.enum(["passkey", "email"]), password: passwordField });
const challengeBody = z.object({ challenge: z.string().max(64) });

/**
 * The second-factor method routes (plan 12c, spec 8.14). None without
 * `totp`. The enable and the disable take a session through
 * `sessionFromRequest`, so a `tk_` bearer answers 401, and the password, on
 * the setup's key `totp-setup:user`. The challenge routes take the `tf_`
 * challenge and no session. A passkey route answers `not_found` without
 * the `passkey` config.
 */
export function secondFactorRoutes(config: ResolvedConfig): Route[] {
  const totp = config.totp;
  if (!totp) return [];
  const trustPath = `${config.basePath}/`;
  const withSession = async (
    ctx: RouteContext,
  ): Promise<{ resolved: ResolvedSession; renewed: string | null } | null> => {
    const resolved = await sessionFromRequest(config, ctx.request);
    if (!resolved) return null;
    return { resolved, renewed: renewedSessionCookie(config, ctx.request, resolved) };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  return [
    {
      method: "POST",
      path: "/second-factor/passkey/enable",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, passkeyEnableBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await enablePasskeyMethod(config, {
          session: s.resolved,
          password: body.value.password,
          response: body.value.response,
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/second-factor/passkey/options",
      async handler(ctx) {
        const body = await readJson(ctx.request, challengeBody);
        if (!body.ok) return respond(body);
        return respond(
          await passkeyChallengeOptions(config, { challenge: body.value.challenge, ip: ctx.ip }),
        );
      },
    },
    {
      method: "POST",
      path: "/second-factor/disable",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // A change of the second factor needs a fresh session (ASVS 5.0.0
        // 7.5.1; plan 12a). The engine takes a user, so the rule is here,
        // before the engine's password limit.
        const fresh = requireFresh(config, s.resolved.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, disableBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await disableMethod(config, {
          user: s.resolved.user,
          method: body.value.method,
          password: body.value.password,
        });
        const res = respond(r);
        // The last method turned the factor off and deleted the trusted devices.
        if (r.ok && r.value.methods.length === 0)
          res.headers.append(
            "set-cookie",
            clearTrustCookie(totp.trustCookieName, trustPath, config.cookie.sameSite),
          );
        return send(res, s.renewed);
      },
    },
    {
      method: "POST",
      path: "/second-factor/email/enable",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, passwordBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await enableEmailMethod(config, {
          session: s.resolved,
          password: body.value.password,
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/second-factor/email/send",
      async handler(ctx) {
        const body = await readJson(ctx.request, challengeBody);
        if (!body.ok) return respond(body);
        return respond(await sendSecondFactorEmail(config, { challenge: body.value.challenge }));
      },
    },
  ];
}
