import type { ResolvedConfig } from "../../config.js";
import {
  destroySession,
  publicSession,
  readSessionToken,
  renewedSessionCookie,
  resolveSession,
} from "../../engine/sessions.js";
import { clearSessionCookie, readCookie } from "../cookies.js";
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
        if (!resolved) {
          // A dead cookie is cleared, so the browser stops sending it.
          const hadCookie = readCookie(ctx.request, config.cookieName) !== null;
          const headers: Record<string, string> = hadCookie
            ? { "set-cookie": clearSessionCookie(config.cookieName, config.cookie.sameSite) }
            : {};
          return json({ error: "unauthorized" }, 401, headers);
        }
        // A sliding refresh moved the expiry. Renew the cookie, or the
        // browser drops it at its old Max-Age.
        const renewed = renewedSessionCookie(config, ctx.request, resolved);
        return json(publicSession(resolved), 200, renewed ? { "set-cookie": renewed } : {});
      },
    },
    {
      method: "POST",
      path: "/sign-out",
      async handler(ctx) {
        const token = readSessionToken(config, ctx.request);
        if (token) await destroySession(config, token);
        const res = json({ ok: true }, 200, {
          "set-cookie": clearSessionCookie(config.cookieName, config.cookie.sameSite),
        });
        // The cookie move (plan 12b): with both names, the router keeps the
        // old cookie, and `token` is the new one. End the old token's session
        // too, and clear the old name, or the next request signs in again
        // under it. A sibling subdomain can set `tempo_session` too.
        const legacy = config.legacyCookieName;
        const old = legacy === null ? null : readCookie(ctx.request, legacy);
        if (legacy !== null && old !== null) {
          if (old !== token) await destroySession(config, old);
          res.headers.append("set-cookie", clearSessionCookie(legacy, config.cookie.sameSite));
        }
        return res;
      },
    },
  ];
}
