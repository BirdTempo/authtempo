import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  type ReauthProof,
  reauthenticate,
  reauthPasskeyOptions,
  requestReauthCode,
} from "../../engine/reauth.js";
import { fail } from "../../result.js";
import { reauthBody } from "../contract/reauth.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

/** One first proof: exactly one of the three, and no `code` beside a passkey. */
function proofOf(body: z.infer<typeof reauthBody>): ReauthProof | null {
  const { password, emailCode, passkey, code } = body;
  const given = [password, emailCode, passkey].filter((p) => p !== undefined).length;
  if (given !== 1) return null;
  if (passkey !== undefined) return code === undefined ? { passkey } : null;
  if (password !== undefined) return { password, code };
  if (emailCode !== undefined) return { emailCode, code };
  return null;
}

/** The re-authentication routes (plan 12a). `/reauth` exists in every deployment. */
export function reauthRoutes(config: ResolvedConfig): Route[] {
  const routes: Route[] = [
    {
      method: "POST",
      path: "/reauth",
      key: "POST /reauth",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, reauthBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        const proof = proofOf(body.value);
        if (!proof) return sent(respond(fail("invalid_body")), s.renewed);
        const r = await reauthenticate(ctx.config, { session: s.resolved, proof, ip: ctx.ip });
        return sent(
          r.ok ? json({ freshUntil: r.value.freshUntil.toISOString() }) : respond(r),
          s.renewed,
        );
      },
    },
  ];
  if (config.passkey)
    routes.push({
      method: "POST",
      path: "/reauth/passkey/options",
      key: "POST /reauth/passkey/options",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        return sent(
          respond(await reauthPasskeyOptions(ctx.config, { session: s.resolved, ip: ctx.ip })),
          s.renewed,
        );
      },
    });
  if (config.emailOtp)
    routes.push({
      method: "POST",
      path: "/reauth/email",
      key: "POST /reauth/email",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        return sent(
          respond(await requestReauthCode(ctx.config, { session: s.resolved })),
          s.renewed,
        );
      },
    });
  return routes;
}
