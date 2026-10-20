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
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The team races of plan 12k (ruling 26) on the real Postgres adapter, through
// core's built output. Postgres runs read committed, so a count in a
// transaction holds a limit only after a lock of the parent row. The first
// call starts the second from its before hook. The hook returns when the
// second call reaches its write of the locked row, or when the second call
// ends. With the lock, the second call waits at that write for the commit.

const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** A storage on the shared pool that calls `reached` before each update or delete of `model` in a transaction. */
function watch(model: ModelName, reached: () => void): StorageAdapter {
  const base = createPostgresAdapter(db.sql);
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
  return createPostgresAdapter(db.sql).create("user", {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
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

const teams = () => createPostgresAdapter(db.sql).findMany("team", []);
const teamRows = () => createPostgresAdapter(db.sql).findMany("teamMember", []);

describe("team races on Postgres (plan 12k Task 5, ruling 26)", () => {
  it("holds a team member add while a team delete waits, so no row of a missing team stays", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let deleted: Promise<unknown> | null = null;
    const two = instance(watch("team", g.reach), { teams: {} }, sent);
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
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
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
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
    const one = instance(createPostgresAdapter(db.sql), config, sent, {
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
});
