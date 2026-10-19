import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  publicUser,
  readBearer,
  renewedSessionCookie,
  sessionFromRequest,
} from "../../engine/sessions.js";
import {
  API_TOKEN_PREFIX,
  createApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken,
} from "../../engine/tokens.js";
import { createBody, revokeBody } from "../contract/tokens.js";
import { json, readJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The token routes. Every route but `current` takes a session through
 * `sessionFromRequest`, which resolves sessions only, so a `tk_` bearer
 * answers 401: a leaked token cannot mint a token or revoke the others.
 */
export function tokenRoutes(config: ResolvedConfig): Route[] {
  /** The session, plus the renewed cookie when the read moved the expiry. */
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(config, ctx.request);
    if (!resolved) return null;
    return {
      user: resolved.user,
      session: resolved.session,
      renewed: renewedSessionCookie(config, ctx.request, resolved),
    };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  return [
    {
      method: "POST",
      path: "/tokens",
      key: "POST /tokens",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // A token is a credential for its life (spec 8.8): a stolen session
        // must not mint one (plan 12a). Before the engine's limit, so a stale
        // session counts no try.
        const fresh = requireFresh(config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, createBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await createApiToken(config, {
          user: s.user,
          name: body.value.name,
          expiresInDays: body.value.expiresInDays,
          ...(body.value.organizationId == null
            ? {}
            : { organizationId: body.value.organizationId }),
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "GET",
      path: "/tokens",
      key: "GET /tokens",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const r = await listApiTokens(config, { user: s.user });
        return send(r.ok ? json({ tokens: r.value }) : respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/tokens/revoke",
      key: "POST /tokens/revoke",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, revokeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(await revokeApiToken(config, { user: s.user, id: body.value.id })),
          s.renewed,
        );
      },
    },
    {
      // A script learns who it is. A `tk_` bearer only: a cookie or a `ts_`
      // bearer is a person, and this route answers 401 to it.
      method: "GET",
      path: "/tokens/current",
      key: "GET /tokens/current",
      async handler(ctx) {
        const bearer = readBearer(ctx.request);
        const t = bearer?.startsWith(API_TOKEN_PREFIX)
          ? await resolveApiToken(config, bearer)
          : null;
        if (!t) return unauthorized();
        return json({ user: publicUser(t.user), apiToken: t.apiToken });
      },
    },
  ];
}
