import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { listIdentities, unlinkIdentity } from "../../engine/identities.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

// An identity id is a core id; the cap bounds the body.
const unlinkBody = z.strictObject({ id: z.string().min(1).max(64) });

/** The identity routes of a settings page (plan 12a). They exist in every deployment. */
export function identityRoutes(config: ResolvedConfig): Route[] {
  return [
    {
      method: "GET",
      path: "/identities",
      key: "GET /identities",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const r = await listIdentities(config, { session: s.resolved });
        if (!r.ok) return sent(respond(r), s.renewed);
        // JSON writes each `linkedAt` as its ISO text.
        return sent(json(r.value), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/identities/unlink",
      key: "POST /identities/unlink",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, unlinkBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await unlinkIdentity(config, {
              session: s.resolved,
              id: body.value.id,
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
