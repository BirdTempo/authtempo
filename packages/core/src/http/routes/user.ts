import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { updateProfile } from "../../engine/profile.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";

const updateBody = z.strictObject({
  // The engine applies the name and image rules; these caps bound the body.
  name: z.string().max(400).nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
});

/** The user routes of a settings page (plan 12a). They exist in every deployment. */
export function userRoutes(config: ResolvedConfig): Route[] {
  return [
    {
      method: "POST",
      path: "/user/update",
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, updateBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(await updateProfile(config, { session: s.resolved, ...body.value })),
          s.renewed,
        );
      },
    },
  ];
}
