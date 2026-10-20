import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import { createRole, deleteRole, getRole, listRoles, updateRole } from "../../engine/roles.js";
import { renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { fail, type Result } from "../../result.js";
import { id } from "../contract/organizations.js";
import { roleCreateBody, roleGetQuery, roleNameBody, roleUpdateBody } from "../contract/roles.js";
import { json, readJson, respond } from "../json.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The dynamic role routes (plan 12k Task 4, spec 29 item 6). They exist when
 * `organizations.dynamicRoles` is set. Each takes a session only, so a token
 * never manages a role (spec 29 item 17). The three writes need a fresh
 * session: a role grants rights to other people.
 */
export function roleRoutes(config: ResolvedConfig): Route[] {
  if (!config.organizations?.dynamicRoles) return [];
  // Same helpers as routes/organizations.ts. The two files evolve apart, so the small copy stays.
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

  /** A write: session, the fresh rule, a checked body, one engine call, the answer under `key` (or the value itself when `key` is null). */
  const write = <T, V, P extends RoutePath<"POST">>(
    path: P,
    schema: z.ZodType<T>,
    key: string | null,
    run: (
      user: NonNullable<Awaited<ReturnType<typeof withSession>>>["user"],
      b: T,
    ) => Promise<Result<V>>,
  ): Route => ({
    method: "POST",
    path,
    key: `POST ${path}`,
    async handler(ctx) {
      const s = await withSession(ctx);
      if (!s) return unauthorized();
      // First, before the body: a stale session and a stolen one learn nothing.
      const fresh = requireFresh(config, s.session);
      if (!fresh.ok) return send(respond(fresh), s.renewed);
      const body = await readJson(ctx.request, schema);
      if (!body.ok) return send(respond(body), s.renewed);
      const r = await run(s.user, body.value);
      if (!r.ok) return send(respond(r), s.renewed);
      return send(json(key === null ? r.value : { [key]: r.value }), s.renewed);
    },
  });

  return [
    {
      method: "GET",
      path: "/organizations/roles",
      key: "GET /organizations/roles",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const parsed = id.safeParse(ctx.url.searchParams.get("organizationId"));
        if (!parsed.success) return send(respond(fail("invalid_body")), s.renewed);
        const r = await listRoles(config, { user: s.user, organizationId: parsed.data });
        return send(r.ok ? json({ roles: r.value }) : respond(r), s.renewed);
      },
    },
    {
      method: "GET",
      path: "/organizations/roles/get",
      key: "GET /organizations/roles/get",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const q = ctx.url.searchParams;
        const parsed = roleGetQuery.safeParse({
          organizationId: q.get("organizationId"),
          name: q.get("name"),
        });
        if (!parsed.success) return send(respond(fail("invalid_body")), s.renewed);
        const r = await getRole(config, { user: s.user, ...parsed.data });
        return send(r.ok ? json({ role: r.value }) : respond(r), s.renewed);
      },
    },
    write("/organizations/roles/create", roleCreateBody, "role", (user, b) =>
      // exactOptionalPropertyTypes: pass only the keys the caller sent.
      createRole(config, {
        user,
        organizationId: b.organizationId,
        name: b.name,
        permissions: b.permissions,
        ...(b.rank !== undefined && { rank: b.rank }),
      }),
    ),
    write("/organizations/roles/update", roleUpdateBody, "role", (user, b) =>
      updateRole(config, {
        user,
        organizationId: b.organizationId,
        name: b.name,
        ...(b.rank !== undefined && { rank: b.rank }),
        ...(b.permissions !== undefined && { permissions: b.permissions }),
      }),
    ),
    write("/organizations/roles/delete", roleNameBody, null, (user, b) =>
      deleteRole(config, { user, ...b }),
    ),
  ];
}
