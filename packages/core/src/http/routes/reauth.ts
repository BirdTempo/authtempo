import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { reauthenticate } from "../../engine/reauth.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

const reauthBody = z.strictObject({
  // The engine refuses more than 128 code points; this cap bounds the body.
  password: z.string().max(1024),
  code: z.string().min(1).max(64).optional(),
});

/** The re-authentication routes (plan 12a). They exist in every deployment. */
export function reauthRoutes(config: ResolvedConfig): Route[] {
  return [
    {
      method: "POST",
      path: "/reauth",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, reauthBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        const r = await reauthenticate(config, {
          session: s.resolved,
          proof: { password: body.value.password, code: body.value.code },
          ip: ctx.ip,
        });
        return sent(
          r.ok ? json({ freshUntil: r.value.freshUntil.toISOString() }) : respond(r),
          s.renewed,
        );
      },
    },
  ];
}
