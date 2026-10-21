import { DatabaseSync } from "node:sqlite";
import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type StorageAdapter,
  systemClock,
  type UserRow,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createAuthClient, organizationClient } from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import type {
  BetterAuthOptions,
  CompatDatabase,
  OrganizationHookOptions,
  OrganizationOptions,
} from "../src/types.js";
import {
  BETTER_AUTH_1421_TEAMS_PG,
  BETTER_AUTH_PG,
  BETTER_AUTH_SQLITE,
  BETTER_AUTH_TEAMS_PG,
  BETTER_AUTH_TEAMS_SQLITE,
} from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
const at = new Date("2026-10-21T00:00:00.000Z");

/**
 * Two pairs and the membershipKey that Better Auth 1.7.2's own adapter wrote
 * for each (getOrgAdapter(...).findOrCreateTeamMember on node:sqlite,
 * 2026-10-21, script plan-12k-task-11-ddl.mjs). A recorded literal: Better
 * Auth is not a dependency.
 */
const BETTER_AUTH_KEYS = [
  { teamId: "t1", userId: "u1", membershipKey: "zvgff7WeYkeF-_knMfCIgYKEgYHUMdUsDbvpoKRzSsY" },
  {
    teamId: "team-x",
    userId: "user-ada",
    membershipKey: "fI2y7lVlp6anBcb2anaCZgihYzj8X3uaaIeJzK99boc",
  },
];

/** The two columns that Better Auth's teams option adds to tables it made before. */
const TEAM_COLUMNS = `ALTER TABLE "session" ADD COLUMN "activeTeamId" text;
ALTER TABLE "invitation" ADD COLUMN "teamId" text;
`;

const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

function options(org: OrganizationOptions, database: CompatDatabase = memory()): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    database,
    plugins: [organization({ ...org, sendInvitationEmail: async () => {} })],
  };
}

async function user(storage: StorageAdapter, id: string, email: string): Promise<UserRow> {
  return storage.create("user", {
    id,
    email,
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: at,
    updatedAt: at,
  }) as Promise<UserRow>;
}

async function organizationRow(storage: StorageAdapter, id: string) {
  await storage.create("organization", {
    id,
    slug: id,
    name: id,
    metadata: null,
    createdAt: at,
    updatedAt: at,
  });
}

/** A shim app with passwords, so a test signs people up as an app does. */
function app(org: OrganizationOptions, database: CompatDatabase = memory()) {
  const mails: { email: string; token: string }[] = [];
  const auth = betterAuth({
    ...options(org, database),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => void mails.push({ email: d.user.email, token: d.token }),
    },
    plugins: [bearer(), organization({ ...org, sendInvitationEmail: async () => {} })],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  /** Signs up, confirms the verify link as a person does, and signs in again. */
  const person = async (email: string) => {
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const link = mails.findLast((m) => m.email === email);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams({ token: link?.token ?? "" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    const token = (await auth.api.signInEmail({ body: { email, password: PASSWORD } })).token;
    const caller = await auth.tempo.caller(
      new Request(BASE, { headers: { authorization: `Bearer ${token}` } }),
    );
    if (caller?.kind !== "session") throw new Error(`no session caller for ${email}`);
    return { token, user: caller.user };
  };
  const client = (token: string) =>
    createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [organizationClient()],
      fetchOptions: {
        customFetchImpl: async (input, init) => auth.handler(new Request(input, init)),
        headers: { authorization: `Bearer ${token}` },
      },
    });
  return { auth, api: auth.tempo.api, storage: database.storage, person, client };
}

/** The argument keys of each team hook in Better Auth 1.7.2's typings (types.d.mts:587 to :688, read 2026-10-21). */
const TEAM_SHAPES = {
  beforeCreateTeam: ["organization", "team", "user"],
  afterCreateTeam: ["organization", "team", "user"],
  beforeUpdateTeam: ["organization", "team", "updates", "user"],
  afterUpdateTeam: ["organization", "team", "user"],
  beforeDeleteTeam: ["organization", "team", "user"],
  afterDeleteTeam: ["organization", "team", "user"],
  beforeAddTeamMember: ["organization", "team", "teamMember", "user"],
  afterAddTeamMember: ["organization", "team", "teamMember", "user"],
  beforeRemoveTeamMember: ["organization", "team", "teamMember", "user"],
  afterRemoveTeamMember: ["organization", "team", "teamMember", "user"],
} satisfies Record<Extract<keyof OrganizationHookOptions, `${string}Team${string}`>, string[]>;

describe("the teams shim (spec 29 item 19)", () => {
  it("writes Better Auth's membershipKey for a team member", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      await user(s.storage, "u1", "u1@example.com");
      await user(s.storage, "user-ada", "ada@example.com");
      await organizationRow(s.storage, "o1");
      for (const [i, k] of BETTER_AUTH_KEYS.entries()) {
        await s.storage.create("team", {
          id: k.teamId,
          organizationId: "o1",
          name: "Blue",
          createdAt: at,
          updatedAt: at,
        });
        await s.storage.create("teamMember", {
          id: `m${i}`,
          teamId: k.teamId,
          organizationId: "o1",
          userId: k.userId,
          createdAt: at,
          updatedAt: at,
        });
      }
      const rows = await pg.sql.unsafe(
        `SELECT "teamId", "userId", "membershipKey" FROM "teamMember" ORDER BY "id"`,
      );
      expect([...rows]).toEqual(BETTER_AUTH_KEYS);
      // Deviation 11: the create writes 0, as Better Auth's createTeam does.
      const counts = await pg.sql.unsafe(`SELECT "memberCount" AS n FROM "team" ORDER BY "id"`);
      expect([...counts]).toEqual([{ n: 0 }, { n: 0 }]);
      // Better Auth's unique key names the pair, so a second row of one pair is core's unique_violation.
      await expect(
        s.storage.create("teamMember", {
          id: "m9",
          teamId: "t1",
          organizationId: "o1",
          userId: "u1",
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toMatchObject({
        code: "unique_violation",
        model: "teamMember",
        fields: ["teamId", "userId"],
      });
    } finally {
      await pg.close();
    }
  });

  it("reads a comma-joined invitation teamId as teamIds and writes it back", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      await user(s.storage, "u1", "u1@example.com");
      await organizationRow(s.storage, "o1");
      await s.storage.create("invitation", {
        id: "i1",
        organizationId: "o1",
        email: "bob@example.com",
        role: "member",
        inviterId: "u1",
        tokenHash: "h1",
        expiresAt: new Date("2026-11-01T00:00:00.000Z"),
        acceptedAt: null,
        teamIds: ["t1", "t2"],
        createdAt: at,
        updatedAt: at,
      });
      const raw = async () =>
        [...(await pg.sql.unsafe(`SELECT "teamId" AS t FROM "invitation"`))][0]?.t;
      const read = async () =>
        (await s.storage.findOne("invitation", [{ field: "id", op: "eq", value: "i1" }]))?.teamIds;
      // Better Auth's own form (organization/adapter.mjs createInvitation).
      expect(await raw()).toBe("t1,t2");
      expect(await read()).toEqual(["t1", "t2"]);
      // Better Auth's removeTeam writes the ids that stay, joined by "," (routes/crud-team.mjs:200).
      await pg.sql.unsafe(`UPDATE "invitation" SET "teamId" = 't2,t3' WHERE "id" = 'i1'`);
      expect(await read()).toEqual(["t2", "t3"]);
      await s.storage.update("invitation", [{ field: "id", op: "eq", value: "i1" }], {
        teamIds: ["t3"],
      });
      expect(await raw()).toBe("t3");
      // An empty list is no list, as Better Auth writes null for no team.
      await s.storage.update("invitation", [{ field: "id", op: "eq", value: "i1" }], {
        teamIds: [],
      });
      expect(await raw()).toBeNull();
      expect(await read()).toBeNull();
      // An id with a comma would read back as two ids, so the write refuses it and keeps the row.
      await expect(
        s.storage.update("invitation", [{ field: "id", op: "eq", value: "i1" }], {
          teamIds: ["a,b"],
        }),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        model: "invitation",
        message: expect.stringMatching(/expected a list of ids with no comma/),
      });
      expect(await raw()).toBeNull();
    } finally {
      await pg.close();
    }
  });

  it("runs consumerd's team hooks with Better Auth's argument keys", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const organizationHooks = Object.fromEntries(
      Object.keys(TEAM_SHAPES).map((name) => [
        name,
        async (data: Record<string, unknown>) => {
          calls.push([name, data]);
        },
      ]),
    ) as OrganizationHookOptions;
    // consumerd's teams option (packages/db/src/auth-options.ts at c43c307) is teams on with Better Auth's
    // defaults, and it sets no team hook. With the two create hooks the default team must be off (ruling 41).
    const { api, person } = app({
      creatorRole: "owner",
      // allowRemovingAllTeams: the delete of the one team below must pass.
      teams: { enabled: true, defaultTeam: { enabled: false }, allowRemovingAllTeams: true },
      organizationHooks,
    });
    const owner = await person("owner@example.com");
    const bob = await person("bob@example.com");
    const created = await api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    // The default team is off, so the create makes no team and fires no team hook.
    expect(calls).toEqual([]);
    expect(
      (
        await api.addMember({
          user: owner.user,
          organizationId,
          userId: bob.user.id,
          role: "member",
        })
      ).ok,
    ).toBe(true);
    const team = await api.createTeam({ user: owner.user, organizationId, name: "Blue" });
    if (!team.ok) throw new Error(team.code);
    const teamId = team.value.id;
    expect((await api.updateTeam({ user: owner.user, teamId, name: "Green" })).ok).toBe(true);
    expect((await api.addTeamMember({ user: owner.user, teamId, userId: bob.user.id })).ok).toBe(
      true,
    );
    expect((await api.removeTeamMember({ user: owner.user, teamId, userId: bob.user.id })).ok).toBe(
      true,
    );
    expect((await api.deleteTeam({ user: owner.user, teamId })).ok).toBe(true);

    expect(calls.map(([name]) => name)).toEqual([
      "beforeCreateTeam",
      "afterCreateTeam",
      "beforeUpdateTeam",
      "afterUpdateTeam",
      "beforeAddTeamMember",
      "afterAddTeamMember",
      "beforeRemoveTeamMember",
      "afterRemoveTeamMember",
      "beforeDeleteTeam",
      "afterDeleteTeam",
    ]);
    for (const [name, data] of calls)
      expect({ name, keys: Object.keys(data).sort() }).toEqual({
        name,
        keys: TEAM_SHAPES[name as keyof typeof TEAM_SHAPES],
      });
    const arg = (name: string) => calls.find(([n]) => n === name)?.[1];
    expect(arg("beforeCreateTeam")).toMatchObject({
      team: { name: "Blue", organizationId },
      user: { id: owner.user.id },
      organization: { id: organizationId, slug: "acme" },
    });
    expect(arg("afterCreateTeam")?.team).toEqual({
      id: teamId,
      name: "Blue",
      organizationId,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(arg("beforeUpdateTeam")).toMatchObject({
      team: { id: teamId, name: "Blue" },
      updates: { name: "Green" },
    });
    expect(arg("afterUpdateTeam")).toMatchObject({ team: { id: teamId, name: "Green" } });
    // The member hooks name the person who joins or leaves as `user`, as Better Auth does.
    expect(arg("beforeAddTeamMember")).toMatchObject({
      teamMember: { teamId, userId: bob.user.id },
      user: { id: bob.user.id },
    });
    expect(arg("afterAddTeamMember")?.teamMember).toEqual({
      id: expect.any(String),
      teamId,
      userId: bob.user.id,
      createdAt: expect.any(Date),
    });
    expect(arg("afterRemoveTeamMember")).toMatchObject({ user: { id: bob.user.id } });
    expect(arg("afterDeleteTeam")).toMatchObject({
      team: { id: teamId },
      user: { id: owner.user.id },
    });
  });

  it("refuses beforeCreateTeam and afterCreateTeam while the default team is on", () => {
    const f = async () => {};
    const refusals = (teams: NonNullable<OrganizationOptions["teams"]> | undefined) =>
      checkOptions(
        options({
          ...(teams !== undefined ? { teams } : {}),
          organizationHooks: { beforeCreateTeam: f, afterCreateTeam: f, beforeUpdateTeam: f },
        }),
      ).refusals;
    const why =
      "core fires no team hook for the default team of an organization create (spec 29 item 19); set teams.defaultTeam { enabled: false } and create the team in afterCreateOrganization";
    expect(refusals({ enabled: true })).toEqual([
      `plugins[organization].organizationHooks.afterCreateTeam: ${why}`,
      `plugins[organization].organizationHooks.beforeCreateTeam: ${why}`,
    ]);
    expect(refusals({ enabled: true, defaultTeam: { enabled: true } })).toHaveLength(2);
    // The way out: no default team, so every team create is a call of the app.
    expect(refusals({ enabled: true, defaultTeam: { enabled: false } })).toEqual([]);
    expect(refusals({ enabled: false })).toEqual([]);
    expect(refusals(undefined)).toEqual([]);
  });

  it("leaves the active team of the session as it is at an organization create", async () => {
    const { person, client, storage } = app({ teams: { enabled: true } });
    const owner = await person("owner@example.com");
    const c = client(owner.token);
    const created = await c.organization.create({ name: "Acme", slug: "acme" });
    expect(created.error).toBeNull();
    // Better Auth sets the new organization and its default team active; core changes no session.
    const rows = await storage.findMany("session", [
      { field: "userId", op: "eq", value: owner.user.id },
    ]);
    // Two sessions: the one of the sign-up and the one of the sign-in.
    expect(rows.map((r) => [r.activeOrganizationId, r.activeTeamId])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect((await c.organization.listUserTeams()).data?.map((t) => t.name)).toEqual(["Acme"]);
  });

  it("answers activeTeamId in the session on the server and the client after setActiveTeam", async () => {
    const { auth, api, person, client } = app({ teams: { enabled: true } });
    const owner = await person("owner@example.com");
    const created = await api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const c = client(owner.token);
    await c.organization.setActive({ organizationId: created.value.organization.id });
    const teamId = (await c.organization.listUserTeams()).data?.[0]?.id ?? "";
    expect((await c.organization.setActiveTeam({ teamId })).error).toBeNull();
    const server = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${owner.token}` }),
    });
    // consumerd reads session.activeTeamId (apps/api/src/middleware/require-session.ts at c43c307).
    expect(Object.keys(server?.session ?? {}).sort()).toEqual([
      "activeOrganizationId",
      "activeTeamId",
      "createdAt",
      "expiresAt",
      "id",
      "ipAddress",
      "token",
      "updatedAt",
      "userAgent",
      "userId",
    ]);
    expect(server?.session.activeTeamId).toBe(teamId);
    const browser = (await c.getSession()).data?.session;
    expect(Object.keys(browser ?? {}).sort()).toEqual([
      "activeOrganizationId",
      "activeTeamId",
      "expiresAt",
      "id",
      "userId",
    ]);
    expect(browser?.activeTeamId).toBe(teamId);
    expect((await c.organization.setActiveTeam({ teamId: null })).error).toBeNull();
    expect((await c.getSession()).data?.session.activeTeamId).toBeNull();
  });

  it("maps allowRemovingAllTeams false onto keepLastTeam", async () => {
    const teamsOf = (teams: NonNullable<OrganizationOptions["teams"]>) => {
      const o = options({ teams });
      expect(checkOptions(o).refusals).toEqual([]);
      const org = mapOptions(o).config.organizations;
      if (!org) throw new Error("no organizations config");
      return { teams: org.teams, limits: org.limits };
    };
    // Better Auth's default of allowRemovingAllTeams is false (routes/crud-team.mjs:179).
    expect(teamsOf({ enabled: true }).teams).toEqual({ defaultTeam: true, keepLastTeam: true });
    expect(teamsOf({ enabled: true, allowRemovingAllTeams: false }).teams).toEqual({
      defaultTeam: true,
      keepLastTeam: true,
    });
    expect(teamsOf({ enabled: true, allowRemovingAllTeams: true }).teams).toEqual({
      defaultTeam: true,
      keepLastTeam: false,
    });
    expect(teamsOf({ enabled: true, defaultTeam: { enabled: false } }).teams).toEqual({
      defaultTeam: false,
      keepLastTeam: true,
    });
    expect(teamsOf({ enabled: false }).teams).toBeUndefined();
    expect(
      teamsOf({ enabled: true, maximumTeams: 3, maximumMembersPerTeam: 5 }).limits,
    ).toMatchObject({ teamsPerOrganization: 3, membersPerTeam: 5 });
    // The function forms and the custom default team are refused (spec 29 item 19).
    const refused = checkOptions(
      options({
        teams: {
          enabled: true,
          maximumTeams: () => 3,
          maximumMembersPerTeam: () => 5,
          defaultTeam: { enabled: true, customCreateDefaultTeam: async () => ({}) },
        } as never,
      }),
    ).refusals;
    expect(refused).toEqual([
      "plugins[organization].teams.defaultTeam.customCreateDefaultTeam: core creates the default team itself, named as the organization (spec 29 item 19)",
      "plugins[organization].teams.maximumMembersPerTeam: a function is refused; pass a positive integer (spec 29 item 19)",
      "plugins[organization].teams.maximumTeams: a function is refused; pass a positive integer (spec 29 item 19)",
    ]);
    // The default keeps the last team: its delete answers Better Auth's code.
    const { api, person, client } = app({ teams: { enabled: true } });
    const owner = await person("owner@example.com");
    const created = await api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const c = client(owner.token);
    await c.organization.setActive({ organizationId: created.value.organization.id });
    const only = (await c.organization.listTeams()).data ?? [];
    expect(only.map((t) => t.name)).toEqual(["Acme"]);
    expect((await c.organization.removeTeam({ teamId: only[0]?.id ?? "" })).error).toMatchObject({
      code: "UNABLE_TO_REMOVE_LAST_TEAM",
      status: 409,
    });
  });

  describe("migrates a database with the team tables and one without", () => {
    it("on Postgres", async () => {
      for (const withTables of [true, false]) {
        const pg = await freshBetterAuthSchema(
          withTables ? BETTER_AUTH_PG + BETTER_AUTH_TEAMS_PG + TEAM_COLUMNS : BETTER_AUTH_PG,
        );
        try {
          await pg.sql.unsafe(
            `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.com', true, $1, $1)`,
            [at.toISOString()],
          );
          await pg.sql.unsafe(
            `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Acme', 'acme', $1)`,
            [at.toISOString()],
          );
          // Rows as Better Auth writes them: its default team has no updatedAt, and the key is its own.
          if (withTables) {
            await pg.sql.unsafe(
              `INSERT INTO "team" ("id", "name", "memberCount", "organizationId", "createdAt") VALUES ('t1', 'Acme', 1, 'o1', $1)`,
              [at.toISOString()],
            );
            await pg.sql.unsafe(
              `INSERT INTO "teamMember" ("id", "teamId", "userId", "membershipKey", "createdAt") VALUES ('m1', 't1', 'u1', $1, $2)`,
              [BETTER_AUTH_KEYS[0]?.membershipKey ?? "", at.toISOString()],
            );
          }
          const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
          await migrateWithoutLock(pg.sql, s.names);
          const columns = await pg.sql.unsafe<{ c: string }[]>(
            `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'teamMember' ORDER BY ordinal_position`,
          );
          expect({ withTables, columns: columns.map((r) => r.c) }).toEqual({
            withTables,
            columns: [
              "id",
              "teamId",
              "userId",
              "membershipKey",
              "createdAt",
              "taOrganizationId",
              "taUpdatedAt",
            ],
          });
          if (!withTables) {
            await s.storage.create("team", {
              id: "t1",
              organizationId: "o1",
              name: "Acme",
              createdAt: at,
              updatedAt: at,
            });
            await s.storage.create("teamMember", {
              id: "m1",
              teamId: "t1",
              organizationId: "o1",
              userId: "u1",
              createdAt: at,
              updatedAt: at,
            });
          }
          expect(await s.storage.findOne("team", [{ field: "id", op: "eq", value: "t1" }])).toEqual(
            { id: "t1", organizationId: "o1", name: "Acme", createdAt: at, updatedAt: at },
          );
          expect(
            await s.storage.findMany("teamMember", [
              { field: "organizationId", op: "eq", value: "o1" },
              { field: "userId", op: "eq", value: "u1" },
            ]),
          ).toEqual([
            {
              id: "m1",
              teamId: "t1",
              organizationId: "o1",
              userId: "u1",
              createdAt: at,
              updatedAt: at,
            },
          ]);
          // Core's unique key on (teamId, userId).
          await expect(
            pg.sql.unsafe(
              `INSERT INTO "teamMember" ("id", "teamId", "userId", "createdAt") VALUES ('m2', 't1', 'u1', now())`,
            ),
          ).rejects.toMatchObject({ code: "23505" });
          expect(
            await pg.sql.unsafe(`SELECT key, value FROM ta_meta ORDER BY key`).then((r) => [...r]),
          ).toEqual([
            { key: "compat_better_auth", value: "11" },
            { key: "schema_version", value: "14" },
          ]);
        } finally {
          await pg.close();
        }
      }
    });

    it("on D1, with the shipped files in node:sqlite", () => {
      const files = import.meta.glob<string>("../migrations/d1/*.sql", {
        query: "?raw",
        import: "default",
        eager: true,
      });
      const shipped = Object.keys(files)
        .sort()
        .map((k) => files[k] as string);
      expect(shipped.length).toBe(11);
      // An app whose tables hold the two teams columns runs 0010 without its two ADD COLUMN lines (ruling 19).
      const teamsLines = [
        `ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;`,
        `ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;`,
      ];
      const own = shipped.map((text, i) =>
        i === 9
          ? text
              .split("\n")
              .filter((l) => !teamsLines.includes(l))
              .join("\n")
          : text,
      );
      for (const withTables of [true, false]) {
        const db = new DatabaseSync(":memory:");
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(
          withTables
            ? BETTER_AUTH_SQLITE + BETTER_AUTH_TEAMS_SQLITE + TEAM_COLUMNS
            : BETTER_AUTH_SQLITE,
        );
        db.exec(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.com', 1, '${at.toISOString()}', '${at.toISOString()}')`,
        );
        db.exec(
          `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o1', 'Acme', 'acme', '${at.toISOString()}')`,
        );
        if (withTables) {
          db.exec(
            `INSERT INTO "team" ("id", "name", "memberCount", "organizationId", "createdAt") VALUES ('t1', 'Acme', 1, 'o1', '${at.toISOString()}')`,
          );
          db.exec(
            `INSERT INTO "teamMember" ("id", "teamId", "userId", "membershipKey", "createdAt") VALUES ('m1', 't1', 'u1', '${BETTER_AUTH_KEYS[0]?.membershipKey}', '${at.toISOString()}')`,
          );
        }
        for (const text of withTables ? own : shipped) db.exec(text);
        const columns = (
          db.prepare(`PRAGMA table_info("teamMember")`).all() as { name: string }[]
        ).map((c) => c.name);
        expect({ withTables, columns }).toEqual({
          withTables,
          columns: [
            "id",
            "teamId",
            "userId",
            "membershipKey",
            "createdAt",
            "taOrganizationId",
            "taUpdatedAt",
          ],
        });
        if (!withTables) {
          db.exec(
            `INSERT INTO "team" ("id", "name", "memberCount", "organizationId", "createdAt") VALUES ('t1', 'Acme', 0, 'o1', '${at.toISOString()}')`,
          );
          db.exec(
            `INSERT INTO "teamMember" ("id", "teamId", "userId", "membershipKey", "createdAt", "taOrganizationId", "taUpdatedAt") VALUES ('m1', 't1', 'u1', '${BETTER_AUTH_KEYS[0]?.membershipKey}', '${at.toISOString()}', 'o1', '${at.toISOString()}')`,
          );
        }
        expect(
          db.prepare(`SELECT "taOrganizationId" AS o, "taUpdatedAt" AS u FROM "teamMember"`).all(),
        ).toEqual([{ o: "o1", u: at.toISOString() }]);
        expect(() =>
          db.exec(
            `INSERT INTO "teamMember" ("id", "teamId", "userId", "createdAt") VALUES ('m2', 't1', 'u1', '${at.toISOString()}')`,
          ),
        ).toThrow(/UNIQUE constraint failed/);
        expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
          { key: "compat_better_auth", value: "11" },
          { key: "schema_version", value: "14" },
        ]);
      }
    });
  });

  it("migrates the team tables of Better Auth 1.4.21 on Postgres, then creates an organization with its default team", async () => {
    const pg = await freshBetterAuthSchema(
      BETTER_AUTH_PG + BETTER_AUTH_1421_TEAMS_PG + TEAM_COLUMNS,
    );
    try {
      // A team and a member row as Better Auth 1.4.21 writes them: no memberCount and no membershipKey.
      await pg.sql.unsafe(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u0', 'Bo', 'bo@example.com', true, $1, $1)`,
        [at.toISOString()],
      );
      await pg.sql.unsafe(
        `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o0', 'Old', 'old', $1)`,
        [at.toISOString()],
      );
      await pg.sql.unsafe(
        `INSERT INTO "team" ("id", "name", "organizationId", "createdAt") VALUES ('t0', 'Old', 'o0', $1)`,
        [at.toISOString()],
      );
      await pg.sql.unsafe(
        `INSERT INTO "teamMember" ("id", "teamId", "userId", "createdAt") VALUES ('m0', 't0', 'u0', $1)`,
        [at.toISOString()],
      );
      const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, database.names);
      const columns = await pg.sql.unsafe<
        { t: string; c: string; type: string; nullable: string; dflt: string | null }[]
      >(
        `SELECT table_name AS t, column_name AS c, data_type AS type, is_nullable AS nullable, column_default AS dflt FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('memberCount', 'membershipKey') ORDER BY table_name`,
      );
      expect([...columns]).toEqual([
        { t: "team", c: "memberCount", type: "integer", nullable: "NO", dflt: "0" },
        { t: "teamMember", c: "membershipKey", type: "text", nullable: "YES", dflt: null },
      ]);
      expect([
        ...(await pg.sql.unsafe(
          `SELECT t."memberCount" AS n, m."membershipKey" AS k FROM "team" t JOIN "teamMember" m ON m."teamId" = t."id"`,
        )),
      ]).toEqual([{ n: 0, k: null }]);

      const { api, storage } = app({ creatorRole: "owner", teams: { enabled: true } }, database);
      const owner = await user(storage, "u1", "ada@example.com");
      const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
      if (!created.ok) throw new Error(created.code);
      const rows = await pg.sql.unsafe<{ name: string; n: number; u: string; k: string }[]>(
        `SELECT t."name", t."memberCount" AS n, m."userId" AS u, m."membershipKey" AS k FROM "team" t JOIN "teamMember" m ON m."teamId" = t."id" WHERE t."organizationId" = $1`,
        [created.value.organization.id],
      );
      expect([...rows]).toEqual([
        { name: "Acme", n: 0, u: "u1", k: expect.stringMatching(/^[\w-]{43}$/) },
      ]);
      // The unique index of the added membershipKey.
      await expect(
        pg.sql.unsafe(
          `INSERT INTO "teamMember" ("id", "teamId", "userId", "membershipKey", "createdAt") VALUES ('m9', 't0', 'u1', $1, now())`,
          [rows[0]?.k ?? ""],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pg.close();
    }
  });

  it("answers check-slug in Better Auth's shape", async () => {
    const { api, person, client } = app({ teams: { enabled: true } });
    const owner = await person("owner@example.com");
    const created = await api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const c = client(owner.token);
    expect(await c.organization.checkSlug({ slug: "free-name" })).toEqual({
      data: { status: true },
      error: null,
    });
    // Better Auth's code for a taken slug (routes/crud-org.mjs:158); the status stays core's.
    expect((await c.organization.checkSlug({ slug: "acme" })).error).toMatchObject({
      code: "ORGANIZATION_SLUG_ALREADY_TAKEN",
      status: 409,
    });
    expect((await c.organization.checkSlug({ slug: "Not A Slug!" })).error).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
  });

  it("serves the team calls of the client in Better Auth's shapes", async () => {
    const { api, person, client } = app({
      creatorRole: "owner",
      teams: { enabled: true, maximumTeams: 2 },
    });
    const owner = await person("owner@example.com");
    const bob = await person("bob@example.com");
    const created = await api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    expect(
      (
        await api.addMember({
          user: owner.user,
          organizationId,
          userId: bob.user.id,
          role: "member",
        })
      ).ok,
    ).toBe(true);
    const c = client(owner.token);
    await c.organization.setActive({ organizationId });
    const made = await c.organization.createTeam({ name: "Blue" });
    expect(made.error).toBeNull();
    expect(made.data).toEqual({
      id: expect.any(String),
      name: "Blue",
      organizationId,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const teamId = made.data?.id ?? "";
    // The default team and Blue: maximumTeams 2 answers Better Auth's code for a third.
    expect((await c.organization.createTeam({ name: "Red" })).error).toMatchObject({
      code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_TEAMS",
      status: 409,
    });
    expect((await c.organization.createTeam({ name: "Red", color: "red" })).error).toMatchObject({
      code: "NOT_SUPPORTED",
      status: 501,
    });
    expect((await c.organization.updateTeam({ teamId, data: { name: "Green" } })).data?.name).toBe(
      "Green",
    );
    expect((await c.organization.listTeams()).data?.map((t) => t.name).sort()).toEqual([
      "Acme",
      "Green",
    ]);
    // A user who is no member of the organization: Better Auth's code, with core's status.
    const carol = await person("carol@example.com");
    expect(
      (await c.organization.addTeamMember({ teamId, userId: carol.user.id })).error,
    ).toMatchObject({ code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION", status: 404 });
    expect(
      (await c.organization.addTeamMember({ teamId: "no-such-team", userId: bob.user.id })).error,
    ).toMatchObject({ code: "TEAM_NOT_FOUND", status: 404 });
    const added = await c.organization.addTeamMember({ teamId, userId: bob.user.id });
    expect(added.data).toEqual({
      id: expect.any(String),
      teamId,
      userId: bob.user.id,
      createdAt: expect.any(Date),
    });
    expect(
      (await c.organization.listTeamMembers({ query: { teamId } })).data?.map((m) => m.userId),
    ).toEqual([bob.user.id]);
    // With no team id, the members of the active team; with no active team, Better Auth's code.
    expect((await c.organization.listTeamMembers()).error).toMatchObject({
      code: "YOU_DO_NOT_HAVE_AN_ACTIVE_TEAM",
      status: 400,
    });
    const own = (await c.organization.listUserTeams()).data ?? [];
    expect(own.map((t) => t.name)).toEqual(["Acme"]);
    const active = await c.organization.setActiveTeam({ teamId: own[0]?.id ?? "" });
    expect(active.data).toMatchObject({ id: own[0]?.id, name: "Acme" });
    expect((await c.organization.listTeamMembers()).data?.map((m) => m.userId)).toEqual([
      owner.user.id,
    ]);
    expect((await c.organization.setActiveTeam({ teamId: null })).data).toBeNull();
    expect(
      (await c.organization.listUserTeams({ query: { userId: bob.user.id } })).error,
    ).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER", status: 403 });
    expect((await c.organization.removeTeamMember({ teamId, userId: bob.user.id })).data).toEqual({
      message: "Team member removed successfully.",
    });
    expect((await c.organization.removeTeam({ teamId })).data).toEqual({
      message: "Team removed successfully.",
    });
    expect((await c.organization.updateTeam({ teamId, data: { name: "X" } })).error).toMatchObject({
      code: "TEAM_NOT_FOUND",
      status: 404,
    });
  });
});
