import type { ResolvedConfig } from "../../config.js";
import {
  destroySession,
  publicSession,
  readSessionToken,
  resolveSession,
} from "../../engine/sessions.js";
import { clearSessionCookie } from "../cookies.js";
import { json } from "../json.js";
import type { Route } from "../router.js";

export function sessionRoutes(config: ResolvedConfig): Route[] {
  return [
    {
      method: "GET",
      path: "/session",
      async handler(ctx) {
        const token = readSessionToken(config, ctx.request);
        const resolved = token ? await resolveSession(config, token) : null;
        if (!resolved) return json({ error: "unauthorized" }, 401);
        return json(publicSession(resolved));
      },
    },
    {
      method: "POST",
      path: "/sign-out",
      async handler(ctx) {
        const token = readSessionToken(config, ctx.request);
        if (token) await destroySession(config, token);
        return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(config.cookieName) });
      },
    },
  ];
}
