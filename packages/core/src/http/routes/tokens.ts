import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import { publicUser, renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import {
  apiTokenFromRequest,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  updateApiToken,
} from "../../engine/tokens.js";
import { createBody, revokeBody, updateBody } from "../contract/tokens.js";
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
          ...(body.value.permissions == null ? {} : { permissions: body.value.permissions }),
          ...(body.value.metadata == null ? {} : { metadata: body.value.metadata }),
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
      // Plan 12k: narrow only (spec 29 item 11). The fresh rule of POST /tokens
      // applies: a stolen session must not change a credential.
      method: "POST",
      path: "/tokens/update",
      key: "POST /tokens/update",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const fresh = requireFresh(config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, updateBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const { id, name, permissions, expiresAt } = body.value;
        const r = await updateApiToken(config, {
          user: s.user,
          id,
          ...(name === undefined ? {} : { name }),
          ...(permissions === undefined ? {} : { permissions }),
          ...(expiresAt === undefined
            ? {}
            : { expiresAt: expiresAt === null ? null : new Date(expiresAt) }),
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      // A script learns who it is. A token bearer only: a cookie or a `ts_`
      // bearer is a person, and this route answers 401 to it. A token
      // failure answers its own code: 429 over the window or the quota.
      method: "GET",
      path: "/tokens/current",
      key: "GET /tokens/current",
      async handler(ctx) {
        const r = await apiTokenFromRequest(config, ctx.request);
        if (!r.ok) return respond(r);
        if (r.value.kind !== "token") return unauthorized();
        return json({ user: publicUser(r.value.user), apiToken: r.value.apiToken });
      },
    },
  ];
}
