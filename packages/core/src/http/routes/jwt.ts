import type { ResolvedConfig } from "../../config.js";
import { mintSessionJwt, publicKeySet } from "../../engine/jwt.js";
import { renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { json, respond } from "../json.js";
import type { Route } from "../router.js";

/**
 * The JWT routes (plan 9g, spec 8.12). `GET /jwks` is public. `GET /token`
 * takes a session through `sessionFromRequest`, which resolves `ts_` tokens
 * only, so a `tk_` bearer or a JWT bearer answers 401: a token never mints a token.
 */
export function jwtRoutes(config: ResolvedConfig): Route[] {
  if (!config.jwtMint) return [];
  return [
    {
      method: "GET",
      path: "/jwks",
      async handler() {
        // A resource server caches it. Five minutes bound the wait for a key after a rotation;
        // a retired key stays in the set for 24 hours, so no token fails in that wait.
        return json(await publicKeySet(config), 200, { "cache-control": "public, max-age=300" });
      },
    },
    {
      method: "GET",
      path: "/token",
      async handler(ctx) {
        const s = await sessionFromRequest(config, ctx.request);
        if (!s) return json({ error: "unauthorized" }, 401);
        const r = await mintSessionJwt(config, { userId: s.user.id, sessionId: s.session.id });
        const res = r.ok ? json({ token: r.value.token }) : respond(r);
        const renewed = renewedSessionCookie(config, ctx.request, s);
        if (renewed) res.headers.append("set-cookie", renewed);
        return res;
      },
    },
  ];
}
