import type { ResolvedConfig } from "../../config.js";
import { setUsername, usernameAvailable } from "../../engine/username.js";
import { availableQuery, setBody } from "../contract/username.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";
import { sent, unauthorized, withSession } from "../session-route.js";
import { readQuery } from "./sso.js";

/**
 * The username routes (plan 12i Task 2, spec 32 item 7). They exist while
 * `username` is on. The check is public by design and counts per IP. The
 * set needs a fresh session.
 */
export function usernameRoutes(config: ResolvedConfig): Route[] {
  if (!config.username) return [];
  return [
    {
      method: "GET",
      path: "/username/available",
      key: "GET /username/available",
      async handler(ctx) {
        const query = readQuery(ctx.url, availableQuery);
        if (!query.ok) return respond(query);
        return respond(
          await usernameAvailable(ctx.config, { username: query.value.username, ip: ctx.ip }),
        );
      },
    },
    {
      method: "POST",
      path: "/user/username",
      key: "POST /user/username",
      async handler(ctx) {
        const s = await withSession(ctx.config, ctx.request);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, setBody);
        if (!body.ok) return sent(respond(body), s.renewed);
        return sent(
          respond(
            await setUsername(ctx.config, {
              session: s.resolved,
              username: body.value.username,
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
