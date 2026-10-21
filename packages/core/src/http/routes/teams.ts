import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  listUserTeams,
  removeTeamMember,
  setActiveTeam,
  updateTeam,
} from "../../engine/teams.js";
import { fail, type Result } from "../../result.js";
import { id } from "../contract/organizations.js";
import {
  teamActiveBody,
  teamBody,
  teamCreateBody,
  teamMemberBody,
  teamUpdateBody,
} from "../contract/teams.js";
import { json, readJson, respond } from "../json.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The team routes (plan 12k Task 5, spec 29 item 7). They exist when
 * `organizations.teams` is set. Each takes a session only, so a token never
 * manages a team (spec 29 item 17).
 */
export function teamRoutes(config: ResolvedConfig): Route[] {
  if (!config.organizations?.teams) return [];
  // Same helpers as routes/roles.ts. The files evolve apart, so the small copy stays.
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(ctx.config, ctx.request);
    if (!resolved) return null;
    return {
      resolved,
      user: resolved.user,
      renewed: renewedSessionCookie(ctx.config, ctx.request, resolved),
    };
  };
  type Signed = NonNullable<Awaited<ReturnType<typeof withSession>>>;
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
    run: (s: Signed, b: T, ctx: RouteContext) => Promise<Result<V>>,
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

  /** A GET route that reads one id from the query, or none when `param` is null. */
  const getBy = <V, P extends RoutePath<"GET">>(
    path: P,
    param: string | null,
    key: string,
    run: (s: Signed, value: string, ctx: RouteContext) => Promise<Result<V>>,
  ): Route => ({
    method: "GET",
    path,
    key: `GET ${path}`,
    async handler(ctx) {
      const s = await withSession(ctx);
      if (!s) return unauthorized();
      let value = "";
      if (param !== null) {
        const parsed = id.safeParse(ctx.url.searchParams.get(param));
        if (!parsed.success) return send(respond(fail("invalid_body")), s.renewed);
        value = parsed.data;
      }
      const r = await run(s, value, ctx);
      if (!r.ok) return send(respond(r), s.renewed);
      return send(json({ [key]: r.value }), s.renewed);
    },
  });

  return [
    getBy("/organizations/teams", "organizationId", "teams", (s, organizationId, ctx) =>
      listTeams(ctx.config, { user: s.user, organizationId }),
    ),
    post("/organizations/teams/create", teamCreateBody, "team", (s, b, ctx) =>
      createTeam(ctx.config, { user: s.user, ...b }),
    ),
    post("/organizations/teams/update", teamUpdateBody, "team", (s, b, ctx) =>
      updateTeam(ctx.config, { user: s.user, ...b }),
    ),
    post("/organizations/teams/delete", teamBody, null, (s, b, ctx) =>
      deleteTeam(ctx.config, { user: s.user, ...b }),
    ),
    getBy("/organizations/teams/members", "teamId", "members", (s, teamId, ctx) =>
      listTeamMembers(ctx.config, { user: s.user, teamId }),
    ),
    post("/organizations/teams/members/add", teamMemberBody, "member", (s, b, ctx) =>
      addTeamMember(ctx.config, { user: s.user, ...b }),
    ),
    post("/organizations/teams/members/remove", teamMemberBody, null, (s, b, ctx) =>
      removeTeamMember(ctx.config, { user: s.user, ...b }),
    ),
    // The active team answers the session, as the active organization does.
    post("/organizations/teams/active", teamActiveBody, null, (s, b, ctx) =>
      setActiveTeam(ctx.config, { session: s.resolved, teamId: b.teamId }),
    ),
    getBy("/organizations/teams/mine", null, "teams", (s, _none, ctx) =>
      listUserTeams(ctx.config, { user: s.user }),
    ),
  ];
}
