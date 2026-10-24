import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OrganizationsConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { ORGANIZATION_HOOK_POINTS, type OrganizationHooks } from "../src/engine/hooks.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";

const P = "/auth/organizations/teams";
const t0 = new Date("2026-01-01T00:00:00.000Z");
const T0 = "2026-01-01T00:00:00.000Z";

function world(
  organizations: OrganizationsConfig = { teams: {} },
  hooks?: OrganizationHooks,
  extra: Partial<AuthConfig> = {},
) {
  let now = t0;
  const clock = {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const sent: string[] = [];
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: {
      send: async (m) => {
        sent.push(m.text);
      },
    },
    clock,
    limiter: createMemoryLimiter(clock),
    organizations,
    ...(hooks && { hooks: { organization: hooks } }),
    ...extra,
  });
  const user = (email: string): Promise<UserRow> =>
    storage.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
  /** A session of `email` through the magic link, as its `ts_` bearer. */
  async function session(email: string): Promise<string> {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.at(-1) ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    return r.value.token;
  }
  /** The invitation token of the last mail. */
  const invitation = () => /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "";
  return { auth, storage, clock, user, session, invitation };
}
type World = ReturnType<typeof world>;

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** An owner (ada), an admin (bob), and a member (carol) of one organization. */
async function acme(w: World) {
  const ada = await w.user("ada@example.com");
  const bob = await w.user("bob@example.com");
  const carol = await w.user("carol@example.com");
  const org = mustOk(
    await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }),
  );
  const organizationId = org.organization.id;
  mustOk(await w.auth.api.addMember({ user: ada, organizationId, userId: bob.id, role: "admin" }));
  mustOk(
    await w.auth.api.addMember({ user: ada, organizationId, userId: carol.id, role: "member" }),
  );
  return { ada, bob, carol, organizationId };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("teams (plan 12k Task 5)", () => {
  it("creates, renames, lists, and deletes a team with the team rights", async () => {
    const w = world();
    const { organizationId } = await acme(w);
    const admin = bearer(await w.session("bob@example.com"));
    const created = await json(
      await w.auth.handle(post(`${P}/create`, { organizationId, name: "Core" }, admin)),
    );
    expect(created).toEqual({
      status: 200,
      body: {
        team: {
          id: expect.any(String),
          organizationId,
          name: "Core",
          createdAt: T0,
          updatedAt: T0,
        },
      },
    });
    const teamId: string = created.body.team.id;
    expect(
      await json(await w.auth.handle(post(`${P}/create`, { organizationId, name: "a\nb" }, admin))),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
    w.clock.advance(1000);
    const renamed = await json(
      await w.auth.handle(post(`${P}/update`, { teamId, name: "Platform" }, admin)),
    );
    expect(renamed).toEqual({
      status: 200,
      body: {
        team: {
          id: teamId,
          organizationId,
          name: "Platform",
          createdAt: T0,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    });
    expect(
      await json(await w.auth.handle(get(`${P}?organizationId=${organizationId}`, admin))),
    ).toEqual({ status: 200, body: { teams: [renamed.body.team] } });
    const member = bearer(await w.session("carol@example.com"));
    expect(
      await json(await w.auth.handle(post(`${P}/create`, { organizationId, name: "X" }, member))),
    ).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    expect(
      await json(await w.auth.handle(post(`${P}/update`, { teamId, name: "X" }, member))),
    ).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    expect(await json(await w.auth.handle(post(`${P}/delete`, { teamId }, member)))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    // A member reads the list: a team is no secret inside its organization.
    expect(
      await json(await w.auth.handle(get(`${P}?organizationId=${organizationId}`, member))),
    ).toEqual({ status: 200, body: { teams: [renamed.body.team] } });
    expect(await json(await w.auth.handle(post(`${P}/delete`, { teamId }, admin)))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await w.storage.findMany("team", [])).toEqual([]);
  });

  it("adds and removes a team member, and lets a member leave a team", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const admin = bearer(await w.session("bob@example.com"));
    const add = (userId: string, h = admin) =>
      w.auth.handle(post(`${P}/members/add`, { teamId: team.id, userId }, h)).then(json);
    expect(await add(carol.id)).toEqual({
      status: 200,
      body: {
        member: {
          id: expect.any(String),
          teamId: team.id,
          userId: carol.id,
          email: "carol@example.com",
          name: null,
          createdAt: T0,
        },
      },
    });
    expect(await add(carol.id)).toEqual({ status: 409, body: { error: "already_member" } });
    expect(await add(bob.id)).toMatchObject({ status: 200 });
    const listed = await json(await w.auth.handle(get(`${P}/members?teamId=${team.id}`, admin)));
    expect(listed.status).toBe(200);
    expect(listed.body.members.map((m: { email: string }) => m.email)).toEqual([
      "bob@example.com",
      "carol@example.com",
    ]);
    const member = bearer(await w.session("carol@example.com"));
    // A member adds no one and removes no one else: member:update and member:delete are an admin's.
    expect(await add(ada.id, member)).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    const remove = (userId: string, h: Record<string, string>) =>
      w.auth.handle(post(`${P}/members/remove`, { teamId: team.id, userId }, h)).then(json);
    expect(await remove(bob.id, member)).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    expect(await json(await w.auth.handle(get(`${P}/mine`, member)))).toEqual({
      status: 200,
      body: { teams: [{ ...team, createdAt: T0, updatedAt: T0 }] },
    });
    // The leave needs membership only.
    expect(await remove(carol.id, member)).toEqual({ status: 200, body: { ok: true } });
    expect(await json(await w.auth.handle(get(`${P}/mine`, member)))).toEqual({
      status: 200,
      body: { teams: [] },
    });
    expect(await remove(bob.id, admin)).toEqual({ status: 200, body: { ok: true } });
    expect(await remove(bob.id, admin)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
  });

  it("runs the touch rule on another person at a team add and a team removal", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: team.id, userId: ada.id }));
    const admin = bearer(await w.session("bob@example.com"));
    const call = (path: string, userId: string) =>
      w.auth.handle(post(`${P}/members/${path}`, { teamId: team.id, userId }, admin)).then(json);
    // bob is an admin: the owner ranks above bob (spec 29 item 5).
    expect(await call("remove", ada.id)).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    mustOk(await w.auth.api.removeTeamMember({ user: ada, teamId: team.id, userId: ada.id }));
    expect(await call("add", ada.id)).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    // A member below bob, and the add of bob by bob, pass.
    expect(await call("add", carol.id)).toMatchObject({ status: 200 });
    expect(await call("add", bob.id)).toMatchObject({ status: 200 });
    expect(await call("remove", carol.id)).toEqual({ status: 200, body: { ok: true } });
    const rows = await w.storage.findMany("teamMember", []);
    expect(rows.map((r) => r.userId)).toEqual([bob.id]);
  });

  it("refuses a team member who is not an organization member", async () => {
    const w = world();
    const { ada, organizationId } = await acme(w);
    const dan = await w.user("dan@example.com");
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const owner = bearer(await w.session("ada@example.com"));
    expect(
      await json(
        await w.auth.handle(post(`${P}/members/add`, { teamId: team.id, userId: dan.id }, owner)),
      ),
    ).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
  });

  it("removes the person's team rows and active team at a member removal", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const other = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "beta", name: "Beta" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({
        user: ada,
        organizationId: other,
        userId: carol.id,
        role: "member",
      }),
    );
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const web = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Web" }));
    const away = mustOk(
      await w.auth.api.createTeam({ user: ada, organizationId: other, name: "Away" }),
    );
    for (const teamId of [core.id, web.id, away.id])
      mustOk(await w.auth.api.addTeamMember({ user: ada, teamId, userId: carol.id }));
    // Two sessions of carol act in the team; a third acts in the other organization.
    for (const teamId of [core.id, web.id]) {
      const h = bearer(await w.session("carol@example.com"));
      await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
      expect(await json(await w.auth.handle(post(`${P}/active`, { teamId }, h)))).toMatchObject({
        status: 200,
        body: { session: { activeTeamId: teamId } },
      });
    }
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId: other }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: away.id }, h));
    mustOk(await w.auth.api.removeMember({ user: ada, organizationId, userId: carol.id }));
    const rows = await w.storage.findMany("teamMember", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(rows.map((r) => r.teamId)).toEqual([away.id]);
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(sessions.map((s) => s.activeTeamId).sort()).toEqual([away.id, null, null]);
  });

  it("removes the person's team rows and active team at a leave", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const other = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "beta", name: "Beta" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({
        user: ada,
        organizationId: other,
        userId: carol.id,
        role: "member",
      }),
    );
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const away = mustOk(
      await w.auth.api.createTeam({ user: ada, organizationId: other, name: "Away" }),
    );
    for (const teamId of [core.id, away.id])
      mustOk(await w.auth.api.addTeamMember({ user: ada, teamId, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    // A leave: carol is the caller and the member.
    mustOk(await w.auth.api.removeMember({ user: carol, organizationId, userId: carol.id }));
    const rows = await w.storage.findMany("teamMember", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(rows.map((r) => r.teamId)).toEqual([away.id]);
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(sessions.map((s) => [s.activeOrganizationId, s.activeTeamId])).toEqual([[null, null]]);
  });

  it("asks member:update for an invite that names teams", async () => {
    const all = {
      organization: ["update", "delete"],
      member: ["read", "create", "update", "delete"],
      invitation: ["read", "create", "cancel"],
      team: ["create", "update", "delete"],
    };
    const w = world({
      teams: {},
      roles: {
        owner: { rank: 4, permissions: all },
        recruiter: { rank: 2, permissions: { invitation: ["create"], member: ["read"] } },
        guest: { rank: 1, permissions: {} },
      },
    });
    const ada = await w.user("ada@example.com");
    const rita = await w.user("rita@example.com");
    const organizationId = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({ user: ada, organizationId, userId: rita.id, role: "recruiter" }),
    );
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const h = bearer(await w.session("rita@example.com"));
    const invite = (body: Record<string, unknown>) =>
      w.auth
        .handle(post("/auth/organizations/invite", { organizationId, role: "guest", ...body }, h))
        .then(json);
    // An invite with teams places a person in a team: the team member add asks member:update.
    expect(await invite({ email: "dan@example.com", teamIds: [team.id] })).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    expect(await w.storage.findMany("invitation", [])).toEqual([]);
    expect(await invite({ email: "dan@example.com" })).toMatchObject({ status: 200 });
  });

  it("refuses an invite that names a team of another organization", async () => {
    const w = world();
    const { ada, organizationId } = await acme(w);
    const other = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "beta", name: "Beta" }),
    ).organization.id;
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const away = mustOk(
      await w.auth.api.createTeam({ user: ada, organizationId: other, name: "Away" }),
    );
    const owner = bearer(await w.session("ada@example.com"));
    expect(
      await json(
        await w.auth.handle(
          post(
            "/auth/organizations/invite",
            {
              organizationId,
              email: "dan@example.com",
              role: "member",
              teamIds: [core.id, away.id],
            },
            owner,
          ),
        ),
      ),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await w.storage.findMany("invitation", [])).toEqual([]);
  });

  it("refuses a team of another organization as the active team", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const other = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "beta", name: "Beta" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({
        user: ada,
        organizationId: other,
        userId: carol.id,
        role: "member",
      }),
    );
    const away = mustOk(
      await w.auth.api.createTeam({ user: ada, organizationId: other, name: "Away" }),
    );
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: away.id, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    // carol is a member of the team, but the team is not a team of the session's active organization.
    expect(await json(await w.auth.handle(post(`${P}/active`, { teamId: away.id }, h)))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect([row?.activeOrganizationId, row?.activeTeamId]).toEqual([organizationId, null]);
  });

  it("cleans every reference at a team delete", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const web = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Web" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    mustOk(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dan@example.com",
        role: "member",
        teamIds: [core.id, web.id],
      }),
    );
    mustOk(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "eve@example.com",
        role: "member",
        teamIds: [core.id],
      }),
    );
    const owner = bearer(await w.session("ada@example.com"));
    expect(
      await json(await w.auth.handle(post(`${P}/delete`, { teamId: core.id }, owner))),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(
      await w.storage.findMany("teamMember", [{ field: "teamId", op: "eq", value: core.id }]),
    ).toEqual([]);
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(sessions.map((s) => s.activeTeamId)).toEqual([null]);
    const invitations = await w.storage.findMany("invitation", [], {
      sort: { field: "email", dir: "asc" },
    });
    expect(invitations.map((i) => [i.email, i.teamIds])).toEqual([
      ["dan@example.com", [web.id]],
      ["eve@example.com", null],
    ]);
  });

  it("deletes teams and team rows with the organization", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    mustOk(await w.auth.api.deleteOrganization({ user: ada, organizationId }));
    expect(await w.storage.findMany("team", [])).toEqual([]);
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(sessions.map((s) => [s.activeOrganizationId, s.activeTeamId])).toEqual([[null, null]]);
  });

  it("adds the accepting person to each team that still exists", async () => {
    const w = world();
    const { ada, organizationId } = await acme(w);
    await w.user("dan@example.com");
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const web = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Web" }));
    mustOk(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dan@example.com",
        role: "member",
        teamIds: [core.id, web.id],
      }),
    );
    const token = w.invitation();
    mustOk(await w.auth.api.deleteTeam({ user: ada, teamId: core.id }));
    const h = bearer(await w.session("dan@example.com"));
    expect(
      await json(await w.auth.handle(post("/auth/organizations/invitations/accept", { token }, h))),
    ).toMatchObject({ status: 200 });
    const rows = await w.storage.findMany("teamMember", []);
    expect(rows.map((r) => [r.teamId, r.organizationId])).toEqual([[web.id, organizationId]]);
  });

  it("keeps the invitation pending when a team is full", async () => {
    const w = world({ teams: {}, limits: { membersPerTeam: 1 } });
    const { ada, bob, carol, organizationId } = await acme(w);
    await w.user("dan@example.com");
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const owner = bearer(await w.session("ada@example.com"));
    const add = (userId: string) =>
      w.auth.handle(post(`${P}/members/add`, { teamId: core.id, userId }, owner)).then(json);
    expect(await add(carol.id)).toMatchObject({ status: 200 });
    expect(await add(bob.id)).toEqual({ status: 409, body: { error: "team_member_limit" } });
    const invited = mustOk(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dan@example.com",
        role: "member",
        teamIds: [core.id],
      }),
    );
    const token = w.invitation();
    const h = bearer(await w.session("dan@example.com"));
    expect(
      await json(await w.auth.handle(post("/auth/organizations/invitations/accept", { token }, h))),
    ).toEqual({ status: 409, body: { error: "team_member_limit" } });
    const row = await w.storage.findOne("invitation", [
      { field: "id", op: "eq", value: invited.id },
    ]);
    expect(row?.acceptedAt).toBeNull();
    expect(await w.storage.findMany("member", [])).toHaveLength(3);
  });

  it("answers team_limit and last_team", async () => {
    const w = world({ teams: { keepLastTeam: true }, limits: { teamsPerOrganization: 2 } });
    const { organizationId } = await acme(w);
    const owner = bearer(await w.session("ada@example.com"));
    const create = (name: string) =>
      w.auth.handle(post(`${P}/create`, { organizationId, name }, owner)).then(json);
    const first = await create("Core");
    const second = await create("Web");
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await create("Ops")).toEqual({ status: 409, body: { error: "team_limit" } });
    const del = (teamId: string) =>
      w.auth.handle(post(`${P}/delete`, { teamId }, owner)).then(json);
    expect(await del(first.body.team.id)).toEqual({ status: 200, body: { ok: true } });
    expect(await del(second.body.team.id)).toEqual({ status: 409, body: { error: "last_team" } });
    expect(await w.storage.findMany("team", [])).toHaveLength(1);
  });

  it("creates the default team at the organization create", async () => {
    const w = world({ teams: { defaultTeam: true } });
    const ada = await w.user("ada@example.com");
    const org = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }),
    );
    const teams = mustOk(
      await w.auth.api.listTeams({ user: ada, organizationId: org.organization.id }),
    );
    expect(teams).toEqual([
      {
        id: expect.any(String),
        organizationId: org.organization.id,
        name: "Acme",
        createdAt: t0,
        updatedAt: t0,
      },
    ]);
    const [team] = teams;
    if (!team) throw new Error("no team");
    expect(
      mustOk(await w.auth.api.listTeamMembers({ user: ada, teamId: team.id })).map((m) => m.userId),
    ).toEqual([ada.id]);
    // With defaultTeam off, the create makes no team.
    const off = world();
    const bea = await off.user("bea@example.com");
    mustOk(await off.auth.api.createOrganization({ user: bea, slug: "beta", name: "Beta" }));
    expect(await off.storage.findMany("team", [])).toEqual([]);
  });

  it("fires the ten team hooks in Better Auth's order and none on a cascade", async () => {
    const calls: [string, unknown][] = [];
    const recorder = Object.fromEntries(
      Object.keys(ORGANIZATION_HOOK_POINTS).map((name) => [
        name,
        (e: unknown) => {
          calls.push([name, e]);
        },
      ]),
    ) as OrganizationHooks;
    const w = world({ teams: {} }, recorder);
    const { ada, carol, organizationId } = await acme(w);
    const names = () =>
      calls
        .map(([name]) => name)
        .filter((name) => name.endsWith("Team") || name.endsWith("TeamMember"));
    calls.length = 0;
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.updateTeam({ user: ada, teamId: team.id, name: "Web" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: team.id, userId: carol.id }));
    mustOk(await w.auth.api.removeTeamMember({ user: ada, teamId: team.id, userId: carol.id }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: team.id, userId: carol.id }));
    expect(names()).toEqual([
      "beforeCreateTeam",
      "afterCreateTeam",
      "beforeUpdateTeam",
      "afterUpdateTeam",
      "beforeAddTeamMember",
      "afterAddTeamMember",
      "beforeRemoveTeamMember",
      "afterRemoveTeamMember",
      "beforeAddTeamMember",
      "afterAddTeamMember",
    ]);
    // The before hook sees the id that the after hook sees.
    const [, before] = calls.find(([name]) => name === "beforeCreateTeam") ?? [];
    const [, after] = calls.find(([name]) => name === "afterCreateTeam") ?? [];
    expect(before).toMatchObject({ team: { id: team.id, name: "Core" }, user: { id: ada.id } });
    expect(after).toMatchObject({
      team: { id: team.id, name: "Core" },
      organization: { id: organizationId },
    });
    // A member removal drops the team row and fires only the member hooks.
    calls.length = 0;
    mustOk(await w.auth.api.removeMember({ user: ada, organizationId, userId: carol.id }));
    expect(calls.map(([name]) => name)).toEqual(["beforeRemoveMember", "afterRemoveMember"]);
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
    // A team delete fires its own two hooks only.
    mustOk(
      await w.auth.api.addMember({ user: ada, organizationId, userId: carol.id, role: "member" }),
    );
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: team.id, userId: carol.id }));
    calls.length = 0;
    mustOk(await w.auth.api.deleteTeam({ user: ada, teamId: team.id }));
    expect(calls.map(([name]) => name)).toEqual(["beforeDeleteTeam", "afterDeleteTeam"]);
  });

  it("clears the active team when the active organization changes", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const other = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "beta", name: "Beta" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({
        user: ada,
        organizationId: other,
        userId: carol.id,
        role: "member",
      }),
    );
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    const web = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Web" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    const active = (teamId: string | null) =>
      w.auth.handle(post(`${P}/active`, { teamId }, h)).then(json);
    // No active organization yet: no team of it.
    expect(await active(core.id)).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    // A team of which carol is not a member.
    expect(await active(web.id)).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    expect(await active(core.id)).toMatchObject({
      status: 200,
      body: { session: { activeOrganizationId: organizationId, activeTeamId: core.id } },
    });
    // The session list names the active team too (ruling 15).
    expect(await json(await w.auth.handle(get("/auth/sessions", h)))).toMatchObject({
      status: 200,
      body: { sessions: [{ activeOrganizationId: organizationId, activeTeamId: core.id }] },
    });
    expect(await active(null)).toMatchObject({
      status: 200,
      body: { session: { activeOrganizationId: organizationId, activeTeamId: null } },
    });
    await active(core.id);
    const moved = await json(
      await w.auth.handle(post("/auth/organizations/active", { organizationId: other }, h)),
    );
    expect(moved).toMatchObject({
      status: 200,
      body: { session: { activeOrganizationId: other, activeTeamId: null } },
    });
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(row?.activeTeamId).toBeNull();
  });

  it("asks member:read for the members list of a team", async () => {
    const all = {
      organization: ["update", "delete"],
      member: ["read", "create", "update", "delete"],
      invitation: ["read", "create", "cancel"],
      team: ["create", "update", "delete"],
    };
    const w = world({
      teams: {},
      roles: { owner: { rank: 4, permissions: all }, guest: { rank: 1, permissions: {} } },
    });
    const ada = await w.user("ada@example.com");
    const gus = await w.user("gus@example.com");
    const organizationId = mustOk(
      await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }),
    ).organization.id;
    mustOk(
      await w.auth.api.addMember({ user: ada, organizationId, userId: gus.id, role: "guest" }),
    );
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: team.id, userId: gus.id }));
    const h = bearer(await w.session("gus@example.com"));
    // A guest has no member:read: the teams list needs membership only, the members list does not.
    expect(
      await json(await w.auth.handle(get(`${P}?organizationId=${organizationId}`, h))),
    ).toMatchObject({ status: 200 });
    expect(await json(await w.auth.handle(get(`${P}/members?teamId=${team.id}`, h)))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
  });

  it("clears the active team of the person only at a team leave", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    for (const userId of [bob.id, carol.id])
      mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId }));
    for (const email of ["bob@example.com", "carol@example.com"]) {
      const h = bearer(await w.session(email));
      await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
      await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    }
    mustOk(await w.auth.api.removeTeamMember({ user: carol, teamId: core.id, userId: carol.id }));
    const active = async (userId: string) =>
      (await w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }])).map(
        (s) => s.activeTeamId,
      );
    expect(await active(carol.id)).toEqual([null]);
    expect(await active(bob.id)).toEqual([core.id]);
  });

  it("keeps the active team when the same organization is set active again", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId: carol.id }));
    const h = bearer(await w.session("carol@example.com"));
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    expect(
      await json(await w.auth.handle(post("/auth/organizations/active", { organizationId }, h))),
    ).toMatchObject({
      status: 200,
      body: { session: { activeOrganizationId: organizationId, activeTeamId: core.id } },
    });
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect(row?.activeTeamId).toBe(core.id);
  });

  it("writes no team back when a delete cleared it after the read of the session", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const core = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    mustOk(await w.auth.api.addTeamMember({ user: ada, teamId: core.id, userId: carol.id }));
    const token = await w.session("carol@example.com");
    const h = bearer(token);
    await w.auth.handle(post("/auth/organizations/active", { organizationId }, h));
    await w.auth.handle(post(`${P}/active`, { teamId: core.id }, h));
    // The read of a request: the session still acts in Core.
    const read = await w.auth.api.getSession(token);
    if (!read) throw new Error("no session");
    expect(read.session.activeTeamId).toBe(core.id);
    mustOk(await w.auth.api.deleteTeam({ user: ada, teamId: core.id }));
    // The set of the same organization runs on the read from before the delete.
    mustOk(await w.auth.api.setActiveOrganization({ session: read, organizationId }));
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: carol.id },
    ]);
    expect([row?.activeOrganizationId, row?.activeTeamId]).toEqual([organizationId, null]);
  });

  it("refuses each team write to a user with no verified address", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    const team = mustOk(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" }));
    // A password sign-up with no use of the link writes such a row. The check comes before the
    // rights, so a non-member gets email_unverified, not forbidden_rank.
    const unverified = await w.storage.create("user", {
      id: newId(t0),
      email: "pat@example.com",
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: t0,
      updatedAt: t0,
    });
    const answers = [
      await w.auth.api.createTeam({ user: unverified, organizationId, name: "Web" }),
      await w.auth.api.updateTeam({ user: unverified, teamId: team.id, name: "Web" }),
      await w.auth.api.addTeamMember({ user: unverified, teamId: team.id, userId: carol.id }),
      await w.auth.api.removeTeamMember({ user: unverified, teamId: team.id, userId: carol.id }),
      await w.auth.api.deleteTeam({ user: unverified, teamId: team.id }),
    ];
    expect(answers.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      "email_unverified",
      "email_unverified",
      "email_unverified",
      "email_unverified",
      "email_unverified",
    ]);
    expect((await w.storage.findMany("team", [])).map((t) => t.name)).toEqual(["Core"]);
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
  });

  it("mounts no team route with teams off", async () => {
    const w = world({});
    const { ada, organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const requests = [
      get(`${P}?organizationId=${organizationId}`, h),
      post(`${P}/create`, { organizationId, name: "Core" }, h),
      post(`${P}/update`, { teamId: "t1", name: "Core" }, h),
      post(`${P}/delete`, { teamId: "t1" }, h),
      get(`${P}/members?teamId=t1`, h),
      post(`${P}/members/add`, { teamId: "t1", userId: ada.id }, h),
      post(`${P}/members/remove`, { teamId: "t1", userId: ada.id }, h),
      post(`${P}/active`, { teamId: null }, h),
      get(`${P}/mine`, h),
    ];
    for (const request of requests)
      expect(await json(await w.auth.handle(request)), request.url).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
    expect(await w.auth.api.createTeam({ user: ada, organizationId, name: "Core" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await w.auth.api.listUserTeams({ user: ada })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    // The session shape keeps its key with teams off.
    expect(await json(await w.auth.handle(get("/auth/session", h)))).toMatchObject({
      status: 200,
      body: { session: { activeTeamId: null } },
    });
  });
});

describe("teams and the operator tools of plan 12f (ruling 16 of plan 12k)", () => {
  const app = { kind: "app", name: "support-tool" } as const;
  const net = { ip: null, userAgent: null };
  /** Teams, the platform organization, and the operator tools, with each team hook counted. */
  function platformWorld(calls: string[]) {
    const hooks = Object.fromEntries(
      Object.keys(ORGANIZATION_HOOK_POINTS)
        .filter((p) => /Team/.test(p))
        .map((p) => [
          p,
          () => {
            calls.push(p);
          },
        ]),
    ) as OrganizationHooks;
    return world(
      { teams: { defaultTeam: true }, platformRole: "admin", platformOrganization: "platform-co" },
      hooks,
      {
        operator: { users: true },
      },
    );
  }

  it("deletes the team rows of the platform organization when a revoke deletes the member row, with no team hook", async () => {
    const calls: string[] = [];
    const w = platformWorld(calls);
    // A verified user, so the operator may create a team in the platform organization.
    const rootUser = await w.user("root@example.com");
    mustOk(
      await w.auth.api.operator.createAdmin({
        actor: app,
        email: "root@example.com",
        reason: "First operator",
        ...net,
      }),
    );
    const bob = await w.user("bob@example.com");
    mustOk(
      await w.auth.api.operator.platformRole.grant({
        actor: app,
        userId: bob.id,
        reason: "Second operator",
        ...net,
      }),
    );
    const platform = await w.storage.findOne("organization", [
      { field: "slug", op: "eq", value: "platform-co" },
    ]);
    if (!platform) throw new Error("no platform organization");
    const team = mustOk(
      await w.auth.api.createTeam({ user: rootUser, organizationId: platform.id, name: "Support" }),
    );
    mustOk(await w.auth.api.addTeamMember({ user: rootUser, teamId: team.id, userId: bob.id }));
    const bobTeams = () =>
      w.storage.findMany("teamMember", [{ field: "userId", op: "eq", value: bob.id }]);
    expect(await bobTeams()).toHaveLength(1);
    calls.length = 0;
    mustOk(
      await w.auth.api.operator.platformRole.revoke({
        actor: app,
        userId: bob.id,
        reason: "Left the team",
        ...net,
      }),
    );
    // The member row went, and its team rows with it; a cascade fires no team hook.
    expect(
      await w.storage.findMany("member", [{ field: "userId", op: "eq", value: bob.id }]),
    ).toEqual([]);
    expect(await bobTeams()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("makes no default team in the platform organization of createAdmin", async () => {
    const w = platformWorld([]);
    mustOk(
      await w.auth.api.operator.createAdmin({
        actor: app,
        email: "root@example.com",
        reason: "First operator",
        ...net,
      }),
    );
    // The platform organization is not an app organization (ruling 16).
    expect(await w.storage.findMany("team", [])).toEqual([]);
    // The same config gives an app organization its default team.
    const ada = await w.user("ada@example.com");
    mustOk(await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }));
    expect(await w.storage.findMany("team", [])).toHaveLength(1);
  });
});
