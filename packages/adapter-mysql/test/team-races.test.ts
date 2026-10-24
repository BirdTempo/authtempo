import {
  createAuth,
  type MailMessage,
  type ModelName,
  type OrganizationHooks,
  type OrganizationsConfig,
  type StorageAdapter,
  type UserRow,
} from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_84, type MysqlDatabase } from "./db.js";

// The port of adapter-postgres/test/team-races.test.ts to MySQL 8.4 (ruling 2
// of plan 12g). The team races of plan 12k (ruling 26) on the real MySQL
// adapter, through core's built output. The adapter runs read committed, so a count in a
// transaction holds a limit only after a lock of the parent row. The first
// call starts the second from its before hook. The hook returns when the
// second call reaches its write of the locked row, or when the second call
// ends. With the lock, the second call waits at that write for the commit.

const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: MysqlDatabase;
beforeEach(async () => {
  db = await freshDatabase(MYSQL_84);
});
afterEach(async () => {
  await db.close();
});

/** A storage on the shared pool that calls `reached` before each update or delete of `model` in a transaction. */
function watch(model: ModelName, reached: () => void): StorageAdapter {
  const base = createMysqlAdapter(db.pool);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    update(m, where, data) {
      if (m === model) reached();
      return tx.update(m, where, data);
    },
    delete(m, where) {
      if (m === model) reached();
      return tx.delete(m, where);
    },
    transaction: (fn) => tx.transaction((inner) => fn(wrap(inner))),
  });
  return { ...base, transaction: (fn) => base.transaction((tx) => fn(wrap(tx))) };
}

/** A storage on the shared pool that runs `fire` once, after the first read of `model`, also in a transaction. */
function onRead(model: ModelName, fire: () => Promise<void>): StorageAdapter {
  let armed = true;
  const wrap = (s: StorageAdapter): StorageAdapter =>
    ({
      ...s,
      async findOne(m: ModelName, where: never) {
        const r = await s.findOne(m, where);
        if (m === model && armed) {
          armed = false;
          await fire();
        }
        return r;
      },
      transaction: (fn: (tx: StorageAdapter) => Promise<unknown>) =>
        s.transaction((tx) => fn(wrap(tx))),
    }) as StorageAdapter;
  return wrap(createMysqlAdapter(db.pool));
}

/** A promise that resolves at the first call of `reach`. */
function gate() {
  let reach = () => {};
  const at = new Promise<void>((r) => {
    reach = r;
  });
  return { at, reach: () => reach() };
}

function instance(
  storage: StorageAdapter,
  organizations: OrganizationsConfig,
  sent: MailMessage[],
  hooks: OrganizationHooks = {},
) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage,
    limiter: { allow: async () => true },
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    clock: { now: () => t0 },
    organizations,
    hooks: { organization: hooks },
  });
}
type Auth = ReturnType<typeof instance>;

function user(id: string): Promise<UserRow> {
  return createMysqlAdapter(db.pool).create("user", {
    id,
    email: `${id}@example.com`,
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
    createdAt: t0,
    updatedAt: t0,
  });
}

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

async function organization(auth: Auth, owner: UserRow): Promise<string> {
  return must(await auth.api.createOrganization({ user: owner, slug: "acme", name: "Acme" }))
    .organization.id;
}

/** A session of `email` through the magic link, as its `ts_` bearer. */
async function sessionOf(auth: Auth, sent: MailMessage[], email: string): Promise<string> {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.token;
}

const post = (path: string, body: unknown, token: string) =>
  new Request(`https://api.example.com/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.com",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const teams = () => createMysqlAdapter(db.pool).findMany("team", []);
const teamRows = () => createMysqlAdapter(db.pool).findMany("teamMember", []);

describe("team races on MySQL 8.4 (plan 12k Task 5, ruling 26)", () => {
  it("holds a team member add while a team delete waits, so no row of a missing team stays", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let deleted: Promise<unknown> | null = null;
    const two = instance(watch("team", g.reach), { teams: {} }, sent);
    const one = instance(createMysqlAdapter(db.pool), { teams: {} }, sent, {
      beforeAddTeamMember: async () => {
        deleted = two.api.deleteTeam({ user: a, teamId });
        await Promise.race([g.at, deleted]);
      },
    });
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(one, a);
    must(await one.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await one.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const added = await one.api.addTeamMember({ user: a, teamId, userId: b.id });

    expect(added).toMatchObject({ ok: true });
    expect(await deleted).toMatchObject({ ok: true });
    expect(await teams()).toEqual([]);
    expect(await teamRows()).toEqual([]);
  });

  it("holds an accept while a team delete waits, so no row of a missing team stays", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let deleted: Promise<unknown> | null = null;
    const two = instance(watch("team", g.reach), { teams: {} }, sent);
    const one = instance(createMysqlAdapter(db.pool), { teams: {} }, sent, {
      beforeAddMember: async (e) => {
        if (e.via !== "invitation") return;
        deleted = two.api.deleteTeam({ user: a, teamId });
        await Promise.race([g.at, deleted]);
      },
    });
    const a = await user("a");
    const d = await user("d");
    const organizationId = await organization(one, a);
    const teamId = must(await one.api.createTeam({ user: a, organizationId, name: "Core" })).id;
    must(
      await one.api.inviteMember({
        user: a,
        organizationId,
        email: "d@example.com",
        role: "member",
        teamIds: [teamId],
      }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";

    const accepted = await one.api.acceptInvitation({ user: d, token, ip: null });

    expect(accepted).toMatchObject({ ok: true });
    expect(await deleted).toMatchObject({ ok: true });
    expect(await teams()).toEqual([]);
    expect(await teamRows()).toEqual([]);
  });

  it("of two team member adds at membersPerTeam 1, one answers team_member_limit", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let second: Promise<unknown> | null = null;
    const config = { teams: {}, limits: { membersPerTeam: 1 } };
    const two = instance(watch("team", g.reach), config, sent);
    const one = instance(createMysqlAdapter(db.pool), config, sent, {
      beforeAddTeamMember: async () => {
        second = two.api.addTeamMember({ user: a, teamId, userId: b.id });
        await Promise.race([g.at, second]);
      },
    });
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(one, a);
    must(await one.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await one.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const first = await one.api.addTeamMember({ user: a, teamId, userId: a.id });

    expect(first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, code: "team_member_limit" });
    expect((await teamRows()).map((r) => r.userId)).toEqual(["a"]);
  });

  it("of two team creates at teamsPerOrganization 1, one answers team_limit", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let second: Promise<unknown> | null = null;
    const config = { teams: {}, limits: { teamsPerOrganization: 1 } };
    const two = instance(watch("organization", g.reach), config, sent);
    const one = instance(createMysqlAdapter(db.pool), config, sent, {
      beforeCreateTeam: async () => {
        second = two.api.createTeam({ user: a, organizationId, name: "Web" });
        await Promise.race([g.at, second]);
      },
    });
    const a = await user("a");
    const organizationId = await organization(one, a);

    const first = await one.api.createTeam({ user: a, organizationId, name: "Core" });

    expect(first).toMatchObject({ ok: true, value: { name: "Core" } });
    expect(await second).toMatchObject({ ok: false, code: "team_limit" });
    expect((await teams()).map((t) => t.name)).toEqual(["Core"]);
  });

  it("of two deletes of the last two teams with keepLastTeam, one answers last_team", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let second: Promise<unknown> | null = null;
    const config = { teams: { keepLastTeam: true } };
    const two = instance(watch("organization", g.reach), config, sent);
    const one = instance(createMysqlAdapter(db.pool), config, sent, {
      beforeDeleteTeam: async () => {
        second = two.api.deleteTeam({ user: a, teamId: web });
        await Promise.race([g.at, second]);
      },
    });
    const a = await user("a");
    const organizationId = await organization(one, a);
    const core = must(await one.api.createTeam({ user: a, organizationId, name: "Core" })).id;
    const web = must(await one.api.createTeam({ user: a, organizationId, name: "Web" })).id;

    const first = await one.api.deleteTeam({ user: a, teamId: core });

    expect(first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, code: "last_team" });
    expect((await teams()).map((t) => t.id)).toEqual([web]);
  });

  // The set holds the session lock from before its checks (ruling 48 of plan 12k). So a removal
  // that starts between the checks and the write waits for the commit, and then clears both.
  // The set waits 600 ms for the removal: with no session lock, the removal commits first, and
  // the set answers forbidden_rank.
  it("holds a member removal between the checks and the write, so the removal clears the active team", async () => {
    const sent: MailMessage[] = [];
    let removal: Promise<unknown> | null = null;
    const plain = instance(createMysqlAdapter(db.pool), { teams: {} }, sent);
    const one = instance(
      onRead("teamMember", async () => {
        removal = plain.api.removeMember({ user: a, organizationId, userId: b.id });
        await Promise.race([removal, new Promise((r) => setTimeout(r, 600))]);
      }),
      { teams: {} },
      sent,
    );
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;
    must(await plain.api.addTeamMember({ user: a, teamId, userId: b.id }));
    const token = await sessionOf(plain, sent, "b@example.com");
    expect(
      (await plain.handle(post("/organizations/active", { organizationId }, token))).status,
    ).toBe(200);

    const res = await one.handle(post("/organizations/teams/active", { teamId }, token));

    expect(res.status).toBe(200);
    expect(await removal).toEqual({ ok: true, value: { ok: true } });
    expect(await createMysqlAdapter(db.pool).findMany("teamMember", [])).toEqual([]);
    const sessions = await createMysqlAdapter(db.pool).findMany("session", [
      { field: "userId", op: "eq", value: b.id },
    ]);
    expect(sessions.map((s) => [s.activeOrganizationId, s.activeTeamId])).toEqual([[null, null]]);
  });

  it("holds a team delete until the active team is written, so the delete clears it", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let deleted: Promise<unknown> | null = null;
    const plain = instance(createMysqlAdapter(db.pool), { teams: {} }, sent);
    const two = instance(watch("team", g.reach), { teams: {} }, sent);
    const one = instance(
      onRead("teamMember", async () => {
        deleted = two.api.deleteTeam({ user: a, teamId });
        await Promise.race([g.at, deleted]);
      }),
      { teams: {} },
      sent,
    );
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;
    must(await plain.api.addTeamMember({ user: a, teamId, userId: b.id }));
    const token = await sessionOf(plain, sent, "b@example.com");
    expect(
      (await plain.handle(post("/organizations/active", { organizationId }, token))).status,
    ).toBe(200);

    await one.handle(post("/organizations/teams/active", { teamId }, token));

    expect(await deleted).toMatchObject({ ok: true });
    expect(await teams()).toEqual([]);
    const sessions = await createMysqlAdapter(db.pool).findMany("session", [
      { field: "userId", op: "eq", value: b.id },
    ]);
    expect(sessions.map((s) => [s.activeOrganizationId, s.activeTeamId])).toEqual([
      [organizationId, null],
    ]);
  });
});
