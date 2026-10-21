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

// The lock order of plan 12k (ruling 43) on the real Postgres adapter,
// through core's built output. Each flow takes the user row first
// (holdUser), then the organization row (lockOrganization), then the team
// row (lockTeam). The first call starts the second from inside its
// transaction. It then waits until the second call reaches the write of a
// row that the first call holds, or until the second call ends.

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

/**
 * A storage on the shared pool that runs `fire` once, after the first read
 * of a `member` row of `userId` outside a transaction. That read is the
 * check before the write.
 */
function onMemberRead(userId: string, fire: () => Promise<void>): StorageAdapter {
  const base = createPostgresAdapter(db.sql);
  let armed = true;
  return {
    ...base,
    async findOne(m, where) {
      const r = await base.findOne(m, where);
      if (
        m === "member" &&
        armed &&
        where.some((w) => w.field === "userId" && w.value === userId)
      ) {
        armed = false;
        await fire();
      }
      return r;
    },
  } as StorageAdapter;
}

/** A storage on the shared pool that runs `fire` once, after the first `op` read of `model` in a transaction. */
function afterRead(
  model: ModelName,
  op: "findOne" | "findMany",
  fire: () => Promise<void>,
): StorageAdapter {
  let armed = true;
  const base = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter =>
    ({
      ...tx,
      async [op](m: ModelName, ...rest: unknown[]) {
        const r = await (tx[op] as (m: ModelName, ...rest: unknown[]) => Promise<unknown>)(
          m,
          ...rest,
        );
        if (m === model && armed) {
          armed = false;
          await fire();
        }
        return r;
      },
      transaction: (fn: (t: StorageAdapter) => Promise<unknown>) =>
        tx.transaction((inner) => fn(wrap(inner))),
    }) as StorageAdapter;
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

/** A session of `email` through the magic link, as its `ts_` bearer. */
async function sessionOf(auth: Auth, sent: MailMessage[], email: string): Promise<string> {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.token;
}

/** The call's answer, or the text of what it threw, such as a Postgres deadlock. */
function settle<T>(p: Promise<T>): Promise<T | string> {
  return p.catch((e: unknown) => `threw ${String(e)}`);
}

const rows = (m: ModelName) => createPostgresAdapter(db.sql).findMany(m, []);

describe("the lock order on Postgres (ruling 43 of plan 12k)", () => {
  it("adds the sole member to a team during the account delete with no deadlock (m3)", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let deleted: Promise<unknown> | null = null;
    const plain = instance(createPostgresAdapter(db.sql), { teams: {} }, sent);
    const two = instance(watch("user", g.reach), { teams: {} }, sent);
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
      beforeAddTeamMember: async () => {
        deleted = settle(two.api.user.delete({ session, ip: null, userAgent: null }));
        await Promise.race([g.at, deleted]);
      },
    });
    const a = await user("a");
    const token = await sessionOf(plain, sent, "a@example.com");
    const session = await plain.api.getSession(token);
    if (!session) throw new Error("no session");
    const organizationId = await organization(plain, a);
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const added = await settle(one.api.addTeamMember({ user: a, teamId, userId: a.id }));

    expect(added).toMatchObject({ ok: true });
    expect(await deleted).toEqual({ ok: true, value: { ok: true } });
    expect(await rows("user")).toEqual([]);
    expect(await rows("team")).toEqual([]);
    expect(await rows("teamMember")).toEqual([]);
  });
  it("holds a member removal during a team member add, so no team row of a non-member stays (m2)", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let removal: Promise<unknown> | null = null;
    const plain = instance(createPostgresAdapter(db.sql), { teams: {} }, sent);
    const two = instance(watch("user", g.reach), { teams: {} }, sent);
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
      beforeAddTeamMember: async () => {
        removal = two.api.removeMember({ user: a, organizationId, userId: b.id });
        await Promise.race([g.at, removal]);
      },
    });
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const added = await one.api.addTeamMember({ user: a, teamId, userId: b.id });

    expect(added).toMatchObject({ ok: true });
    expect(await removal).toEqual({ ok: true, value: { ok: true } });
    expect((await rows("member")).map((m) => m.userId)).toEqual(["a"]);
    expect(await rows("teamMember")).toEqual([]);
  });

  it("holds the removal of a second owner during a team member add, so no team row of a non-member stays (m2)", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let removal: Promise<unknown> | null = null;
    const plain = instance(createPostgresAdapter(db.sql), { teams: {} }, sent);
    const two = instance(watch("user", g.reach), { teams: {} }, sent);
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
      beforeAddTeamMember: async () => {
        removal = two.api.removeMember({ user: a, organizationId, userId: b.id });
        await Promise.race([g.at, removal]);
      },
    });
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: b.id, role: "owner" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const added = await one.api.addTeamMember({ user: a, teamId, userId: b.id });

    expect(added).toMatchObject({ ok: true });
    expect(await removal).toEqual({ ok: true, value: { ok: true } });
    expect((await rows("member")).map((m) => m.userId)).toEqual(["a"]);
    expect(await rows("teamMember")).toEqual([]);
  });

  it("answers not_found to a team member add when a removal commits after its member read (m2)", async () => {
    const sent: MailMessage[] = [];
    const plain = instance(createPostgresAdapter(db.sql), { teams: {} }, sent);
    const one = instance(
      onMemberRead("b", async () => {
        must(await plain.api.removeMember({ user: a, organizationId, userId: b.id }));
      }),
      { teams: {} },
      sent,
    );
    const a = await user("a");
    const b = await user("b");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: b.id, role: "member" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;

    const added = await one.api.addTeamMember({ user: a, teamId, userId: b.id });

    expect(added).toMatchObject({ ok: false, code: "not_found" });
    expect((await rows("member")).map((m) => m.userId)).toEqual(["a"]);
    expect(await rows("teamMember")).toEqual([]);
  });

  it("holds a member removal during an accept by that member, so no team row of a non-member stays (m2)", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let removal: Promise<unknown> | null = null;
    const plain = instance(createPostgresAdapter(db.sql), { teams: {} }, sent);
    const two = instance(watch("user", g.reach), { teams: {} }, sent);
    const one = instance(createPostgresAdapter(db.sql), { teams: {} }, sent, {
      beforeAddMember: async (e) => {
        if (e.via !== "invitation") return;
        removal = two.api.removeMember({ user: a, organizationId, userId: d.id });
        await Promise.race([g.at, removal]);
      },
    });
    const a = await user("a");
    const d = await user("d");
    const organizationId = await organization(plain, a);
    must(await plain.api.addMember({ user: a, organizationId, userId: d.id, role: "member" }));
    const teamId = must(await plain.api.createTeam({ user: a, organizationId, name: "Core" })).id;
    must(
      await plain.api.inviteMember({
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
    expect(await removal).toEqual({ ok: true, value: { ok: true } });
    expect((await rows("member")).map((m) => m.userId)).toEqual(["a"]);
    expect(await rows("teamMember")).toEqual([]);
  });
  it("of two role creates at maxPerOrganization 1, one answers role_limit (m1)", async () => {
    const sent: MailMessage[] = [];
    const g = gate();
    let second: Promise<unknown> | null = null;
    const config = { dynamicRoles: { maxPerOrganization: 1 } };
    const plain = instance(createPostgresAdapter(db.sql), config, sent);
    const two = instance(watch("organization", g.reach), config, sent);
    const one = instance(
      afterRead("organizationRole", "findMany", async () => {
        second = two.api.createRole({
          user: a,
          organizationId,
          name: "web",
          permissions: { member: ["read"] },
        });
        await Promise.race([g.at, second]);
      }),
      config,
      sent,
    );
    const a = await user("a");
    const organizationId = await organization(plain, a);

    const first = await one.api.createRole({
      user: a,
      organizationId,
      name: "core",
      permissions: { member: ["read"] },
    });

    expect(first).toMatchObject({ ok: true, value: { name: "core" } });
    expect(await second).toMatchObject({ ok: false, code: "role_limit" });
    expect((await rows("organizationRole")).map((r) => r.name)).toEqual(["core"]);
  });
});
