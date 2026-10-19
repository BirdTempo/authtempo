import type { ResolvedConfig } from "../../config.js";
import { checkSessionLive, mintSessionJwt, publicKeySet } from "../../engine/jwt.js";
import { readBearer, renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { json, respond } from "../json.js";
import type { Route } from "../router.js";

/**
 * The JWT routes (plan 9g, spec 8.12). `GET /jwks` is public. `GET /token`
 * takes a session through `sessionFromRequest`, which resolves `ts_` tokens
 * only, so a `tk_` bearer or a JWT bearer answers 401: a token never mints a token.
 * `POST /token/live` (plan 11d) takes a session JWT as the bearer and answers
 * whether its session still exists.
 */
export function jwtRoutes(config: ResolvedConfig): Route[] {
  if (!config.jwtMint) return [];
  return [
    {
      method: "GET",
      path: "/jwks",
      key: "GET /jwks",
      async handler() {
        // A resource server caches it. Five minutes bound the wait for a key after a rotation;
        // a retired key stays in the set for 24 hours, so no token fails in that wait.
        return json(await publicKeySet(config), 200, { "cache-control": "public, max-age=300" });
      },
    },
    {
      method: "GET",
      path: "/token",
      key: "GET /token",
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
    {
      // The live check of a session JWT (plan 11d). The bearer is the JWT, never the
      // cookie: a resource server forwards the token it holds. No body.
      method: "POST",
      path: "/token/live",
      key: "POST /token/live",
      async handler(ctx) {
        return respond(await checkSessionLive(config, readBearer(ctx.request)));
      },
    },
  ];
}
