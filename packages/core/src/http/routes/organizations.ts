import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  acceptInvitation,
  declineInvitation,
  inviteMember,
  listInvitations,
  revokeInvitation,
  setActiveOrganization,
} from "../../engine/invitations.js";
import {
  createOrganizationToken,
  listOrganizationTokens,
  revokeOrganizationToken,
  updateOrganizationToken,
} from "../../engine/organization-tokens.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  listMembers,
  listOrganizations,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from "../../engine/organizations.js";
import { hasPermission, permissionsOf } from "../../engine/permissions.js";
import { renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { checkSlug } from "../../engine/slug-check.js";
import { organizationTokenFromRequest } from "../../engine/tokens.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow } from "../../schema.js";
import {
  activeBody,
  checkSlugBody,
  createBody,
  hasPermissionBody,
  id,
  inviteBody,
  memberBody,
  orgBody,
  orgTokenCreateBody,
  orgTokenRevokeBody,
  orgTokenUpdateBody,
  removeBody,
  revokeBody,
  tokenBody,
  updateBody,
} from "../contract/organizations.js";
import { json, readJson, respond } from "../json.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";

export function organizationRoutes(config: ResolvedConfig): Route[] {
  if (!config.organizations) return [];
  // Same two helpers as routes/passkeys.ts. The two files evolve apart, so the small copy stays.
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(ctx.config, ctx.request);
    if (!resolved) return null;
    return {
      resolved,
      user: resolved.user,
      renewed: renewedSessionCookie(ctx.config, ctx.request, resolved),
    };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);

  /** A POST route: session, a checked body, one engine call, the answer under `key` (or the value itself when `key` is null). */
  const post = <T, V, P extends RoutePath<"POST">>(
    path: P,
    schema: z.ZodType<T>,
    key: string | null,
    run: (
      s: NonNullable<Awaited<ReturnType<typeof withSession>>>,
      b: T,
      ctx: RouteContext,
    ) => Promise<Result<V>>,
  ): Route => ({
    method: "POST",
    path,
    key: `POST ${path}`,
    async handler(ctx) {
      const s = await withSession(ctx);
      if (!s) return unauthorized();
      const body = await readJson(ctx.request, schema);
      if (!body.ok) return send(respond(body), s.renewed);
      const r = await run(s, body.value, ctx);
      if (!r.ok) return send(respond(r), s.renewed);
      return send(json(key === null ? r.value : { [key]: r.value }), s.renewed);
    },
  });

  /** A GET route that reads `?organizationId=`. */
  const getByOrg = <V, P extends RoutePath<"GET">>(
    path: P,
    key: string,
    run: (
      user: NonNullable<Awaited<ReturnType<typeof withSession>>>["user"],
      organizationId: string,
      ctx: RouteContext,
      // The session row of the caller, for a check of its `proved` flag (plan 12p).
      session: SessionRow,
    ) => Promise<Result<V>>,
  ): Route => ({
    method: "GET",
    path,
    key: `GET ${path}`,
    async handler(ctx) {
      const s = await withSession(ctx);
      if (!s) return unauthorized();
      const parsed = id.safeParse(ctx.url.searchParams.get("organizationId"));
      if (!parsed.success) return send(respond(fail("invalid_body")), s.renewed);
      const r = await run(s.user, parsed.data, ctx, s.resolved.session);
      if (!r.ok) return send(respond(r), s.renewed);
      return send(json({ [key]: r.value }), s.renewed);
    },
  });

  return [
    {
      // The create answer carries two keys, so it builds its own body.
      method: "POST",
      path: "/organizations/create",
      key: "POST /organizations/create",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, createBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await createOrganization(ctx.config, {
          user: s.user,
          // The session, so a session made before the proof makes no organization (plan 12p).
          session: s.resolved.session,
          slug: body.value.slug,
          name: body.value.name,
          ...(body.value.metadata !== undefined && { metadata: body.value.metadata }),
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "GET",
      path: "/organizations",
      key: "GET /organizations",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const r = await listOrganizations(ctx.config, { user: s.user });
        return send(r.ok ? json({ organizations: r.value }) : respond(r), s.renewed);
      },
    },
    post("/organizations/update", updateBody, "organization", (s, b, ctx) =>
      // exactOptionalPropertyTypes: pass only the keys the caller sent.
      updateOrganization(ctx.config, {
        user: s.user,
        session: s.resolved.session,
        organizationId: b.organizationId,
        ...(b.name !== undefined && { name: b.name }),
        ...(b.slug !== undefined && { slug: b.slug }),
        ...(b.metadata !== undefined && { metadata: b.metadata }),
      }),
    ),
    post("/organizations/delete", orgBody, null, (s, b, ctx) =>
      deleteOrganization(ctx.config, { user: s.user, session: s.resolved.session, ...b }),
    ),
    getByOrg("/organizations/members", "members", (user, organizationId, ctx) =>
      listMembers(ctx.config, { user, organizationId }),
    ),
    post("/organizations/members/add", memberBody, "member", (s, b, ctx) =>
      addMember(ctx.config, { user: s.user, session: s.resolved.session, ...b }),
    ),
    post("/organizations/members/role", memberBody, "member", (s, b, ctx) =>
      updateMemberRole(ctx.config, { user: s.user, session: s.resolved.session, ...b }),
    ),
    post("/organizations/members/remove", removeBody, null, async (s, b, ctx) => {
      // The revoke of tokens changes credentials, so it needs a fresh session (plan 12k), before any write.
      if (b.revokeTokens === true) {
        const fresh = requireFresh(ctx.config, s.resolved.session);
        if (!fresh.ok) return fresh;
      }
      return removeMember(ctx.config, {
        user: s.user,
        session: s.resolved.session,
        organizationId: b.organizationId,
        userId: b.userId,
        ...(b.revokeTokens !== undefined && { revokeTokens: b.revokeTokens }),
      });
    }),
    post("/organizations/invite", inviteBody, "invitation", (s, b, ctx) =>
      // exactOptionalPropertyTypes: pass teamIds only when the caller sent it.
      inviteMember(ctx.config, {
        user: s.user,
        session: s.resolved.session,
        organizationId: b.organizationId,
        email: b.email,
        role: b.role,
        ...(b.teamIds !== undefined && { teamIds: b.teamIds }),
      }),
    ),
    getByOrg("/organizations/invitations", "invitations", (user, organizationId, ctx) =>
      listInvitations(ctx.config, { user, organizationId }),
    ),
    post("/organizations/invitations/revoke", revokeBody, null, (s, b, ctx) =>
      revokeInvitation(ctx.config, { user: s.user, session: s.resolved.session, ...b }),
    ),
    // Accept answers { organization, member } as the engine returns it.
    post("/organizations/invitations/accept", tokenBody, null, (s, b, ctx) =>
      acceptInvitation(ctx.config, {
        user: s.user,
        session: s.resolved.session,
        token: b.token,
        ip: ctx.ip,
      }),
    ),
    {
      // The link in the mail is the credential, so decline needs no session.
      method: "POST",
      path: "/organizations/invitations/decline",
      key: "POST /organizations/invitations/decline",
      async handler(ctx) {
        const body = await readJson(ctx.request, tokenBody);
        if (!body.ok) return respond(body);
        // A session is optional: the after hook names its user when the request carries one.
        const s = await withSession(ctx);
        return send(
          respond(
            await declineInvitation(ctx.config, { token: body.value.token, user: s?.user ?? null }),
          ),
          s?.renewed ?? null,
        );
      },
    },
    // A session only: a token never asks about rights in core's routes (spec 29 item 17).
    post("/organizations/has-permission", hasPermissionBody, "success", async (s, b, ctx) =>
      ok(await hasPermission(ctx.config, { kind: "session", ...s.resolved }, b)),
    ),
    {
      // The answer carries two keys, so it builds its own body.
      method: "GET",
      path: "/organizations/permissions",
      key: "GET /organizations/permissions",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const parsed = id.safeParse(ctx.url.searchParams.get("organizationId"));
        if (!parsed.success) return send(respond(fail("invalid_body")), s.renewed);
        const r = await permissionsOf(ctx.config, { kind: "session", ...s.resolved }, parsed.data);
        return send(respond(r), s.renewed);
      },
    },
    // A session only, as the create: a token never checks a slug (spec 29 items 8 and 17).
    post("/organizations/check-slug", checkSlugBody, null, (s, b, ctx) =>
      checkSlug(ctx.config, { user: s.user, session: s.resolved.session, slug: b.slug }),
    ),
    // Plan 12k: tokens that the organization owns. A session only: a token never makes or changes a token.
    // A token is a credential for its life (spec 8.8), so the create and the update need a fresh session.
    post("/organizations/tokens", orgTokenCreateBody, null, async (s, b, ctx) => {
      const fresh = requireFresh(ctx.config, s.resolved.session);
      if (!fresh.ok) return fresh;
      // The session, not the bare user: a session made before the proof mints nothing (plan 12p).
      return createOrganizationToken(ctx.config, {
        session: s.resolved,
        organizationId: b.organizationId,
        name: b.name,
        permissions: b.permissions,
        ...(b.expiresInDays !== undefined && { expiresInDays: b.expiresInDays }),
        ...(b.metadata != null && { metadata: b.metadata }),
      });
    }),
    getByOrg("/organizations/tokens", "tokens", (user, organizationId, ctx, session) =>
      listOrganizationTokens(ctx.config, { user, session, organizationId }),
    ),
    post("/organizations/tokens/update", orgTokenUpdateBody, null, async (s, b, ctx) => {
      const fresh = requireFresh(ctx.config, s.resolved.session);
      if (!fresh.ok) return fresh;
      const { organizationId, id: tokenId, name, permissions, expiresAt } = b;
      return updateOrganizationToken(ctx.config, {
        user: s.user,
        session: s.resolved.session,
        organizationId,
        id: tokenId,
        ...(name !== undefined && { name }),
        ...(permissions !== undefined && { permissions }),
        ...(expiresAt !== undefined && {
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        }),
      });
    }),
    post("/organizations/tokens/revoke", orgTokenRevokeBody, null, (s, b, ctx) =>
      revokeOrganizationToken(ctx.config, { user: s.user, session: s.resolved.session, ...b }),
    ),
    {
      // A script learns which organization it acts for. A `to_` bearer only: any
      // other credential answers 401. A token failure answers its own code.
      method: "GET",
      path: "/organizations/tokens/current",
      key: "GET /organizations/tokens/current",
      async handler(ctx) {
        const r = await organizationTokenFromRequest(ctx.config, ctx.request);
        if (!r.ok) return respond(r);
        if (r.value.kind !== "organizationToken") return unauthorized();
        return json({ organization: r.value.organization, apiToken: r.value.apiToken });
      },
    },
    // Active answers { user, session } as the engine returns it.
    post("/organizations/active", activeBody, null, (s, b, ctx) =>
      setActiveOrganization(ctx.config, { session: s.resolved, organizationId: b.organizationId }),
    ),
  ];
}
