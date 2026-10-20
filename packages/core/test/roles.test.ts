import { afterEach, describe, expect, it, vi } from "vitest";
import type { Statements } from "../src/access.js";
import { type DynamicRolesConfig, type OrganizationsConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { Caller } from "../src/engine/tokens.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";

const P = "/auth/organizations/roles";
const t0 = new Date("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;

function world(
  organizations: OrganizationsConfig = { dynamicRoles: {} },
  wrap = (s: StorageAdapter) => s,
  base: StorageAdapter = createMemoryAdapter(),
) {
  let now = t0;
  const clock = {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  const storage = wrap(base);
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
  });
  const user = (email: string): Promise<UserRow> =>
    base.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: now,
      updatedAt: now,
    });
  /** A fresh session of `email` through the magic link, as its `ts_` bearer. */
  async function session(email: string): Promise<string> {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.at(-1) ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    return r.value.token;
  }
  async function caller(token: string): Promise<Caller> {
    const c = await auth.caller(
      new Request(`${BASE_URL}/app`, { headers: { authorization: `Bearer ${token}` } }),
    );
    if (!c) throw new Error("no caller");
    return c;
  }
  /** The token of the last invitation mail. */
  const invitationToken = () =>
    /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "";
  return { auth, storage: base, clock, user, session, caller, invitationToken };
}

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** An owner (ada), an admin (bob), and a member (carol) of one organization. */
async function acme(w: ReturnType<typeof world>) {
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

describe("dynamic roles (plan 12k Task 4)", () => {
  it("creates, lists, gets, updates, and deletes a role", async () => {
    const w = world();
    const { organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const created = await json(
      await w.auth.handle(
        post(
          `${P}/create`,
          {
            organizationId,
            name: "editor",
            rank: 2,
            permissions: { member: ["read"], invitation: ["read", "create"] },
          },
          h,
        ),
      ),
    );
    expect(created).toEqual({
      status: 200,
      body: {
        role: {
          id: expect.any(String),
          name: "editor",
          rank: 2,
          permissions: { member: ["read"], invitation: ["read", "create"] },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const role = created.body.role;
    expect(
      await json(await w.auth.handle(get(`${P}?organizationId=${organizationId}`, h))),
    ).toEqual({ status: 200, body: { roles: [role] } });
    const getOne = () =>
      w.auth.handle(get(`${P}/get?organizationId=${organizationId}&name=editor`, h));
    expect(await json(await getOne())).toEqual({ status: 200, body: { role } });

    w.clock.advance(60_000);
    expect(
      await json(
        await w.auth.handle(
          post(
            `${P}/update`,
            { organizationId, name: "editor", permissions: { member: ["read"] } },
            h,
          ),
        ),
      ),
    ).toEqual({
      status: 200,
      body: {
        role: {
          ...role,
          permissions: { member: ["read"] },
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      },
    });
    expect((await json(await getOne())).body.role.permissions).toEqual({ member: ["read"] });

    expect(
      await json(await w.auth.handle(post(`${P}/delete`, { organizationId, name: "editor" }, h))),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(await json(await getOne())).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.storage.findMany("organizationRole", [])).toEqual([]);
  });

  it("refuses a name of the config, the platform role, and owner", async () => {
    const w = world({
      dynamicRoles: {},
      platformOrganization: "platform-co",
      platformRole: "operator",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    });
    const { ada, organizationId } = await acme(w);
    const create = (name: string) =>
      w.auth.api.createRole({
        user: ada,
        organizationId,
        name,
        rank: 1,
        permissions: { member: ["read"] },
      });
    for (const name of ["admin", "operator", "owner"])
      expect(await create(name), name).toMatchObject({ ok: false, code: "invalid_body" });
    // A comma would make one stored row two role parts.
    expect(await create("viewer,editor")).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await create("editor")).toMatchObject({ ok: true, value: { name: "editor" } });
    expect((await w.storage.findMany("organizationRole", [])).map((r) => r.name)).toEqual([
      "editor",
    ]);
  });

  it("refuses a dynamic role at the owner rank and above the caller", async () => {
    const w = world();
    const { ada, bob, organizationId } = await acme(w);
    const create = (user: UserRow, name: string, rank: number) =>
      w.auth.api.createRole({
        user,
        organizationId,
        name,
        rank,
        permissions: { member: ["read"] },
      });
    // The default table: owner 4, admin 3.
    expect(await create(ada, "top", 4)).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await create(ada, "high", 3)).toMatchObject({ ok: true, value: { rank: 3 } });
    expect(await create(bob, "lead", 3)).toMatchObject({ ok: true, value: { rank: 3 } });
    expect(await create(bob, "chief", 4)).toMatchObject({ ok: false, code: "invalid_body" });
    for (const rank of [0, -1, 1.5])
      expect(await create(ada, "odd", rank), String(rank)).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    // With room below the owner rank, the caller's own rank is the ceiling.
    const v = world({ dynamicRoles: {}, ranks: { viewer: 1, member: 2, admin: 3, owner: 10 } });
    const c = await acme(v);
    const make = (user: UserRow, name: string) =>
      v.auth.api.createRole({
        user,
        organizationId: c.organizationId,
        name,
        rank: 4,
        permissions: { member: ["read"] },
      });
    expect(await make(c.bob, "above")).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await make(c.ada, "above")).toMatchObject({ ok: true, value: { rank: 4 } });
  });

  it("refuses permissions wider than the caller's", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const create = (name: string, permissions: Statements) =>
      w.auth.api.createRole({ user: bob, organizationId, name, permissions });
    expect(await create("wide", { organization: ["delete"] })).toMatchObject({
      ok: false,
      code: "forbidden_rank",
    });
    // A name that is no known resource is a bad body, not a missing right.
    expect(await create("odd", { project: ["read"] })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await create("narrow", { member: ["read", "create"] })).toMatchObject({
      ok: true,
      value: { rank: 1, permissions: { member: ["read", "create"] } },
    });
    // A role that holds a right the admin lacks: the admin can neither change nor delete it.
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "closer",
        permissions: { organization: ["delete"] },
      }),
    );
    const own = { user: bob, organizationId, name: "closer" };
    expect(
      await w.auth.api.updateRole({ ...own, permissions: { member: ["read"] } }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(await w.auth.api.deleteRole(own)).toMatchObject({ ok: false, code: "forbidden_rank" });
    // The default member holds ac:read and no ac:create.
    expect(
      await w.auth.api.createRole({
        user: carol,
        organizationId,
        name: "mine",
        permissions: { member: ["read"] },
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(await w.auth.api.listRoles({ user: carol, organizationId })).toMatchObject({ ok: true });
    expect((await w.storage.findMany("organizationRole", [])).map((r) => r.name).sort()).toEqual([
      "closer",
      "narrow",
    ]);
  });

  it("answers role_taken for a second create of one name", async () => {
    const w = world();
    const { organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const create = async () =>
      json(
        await w.auth.handle(
          post(
            `${P}/create`,
            { organizationId, name: "editor", permissions: { member: ["read"] } },
            h,
          ),
        ),
      );
    expect((await create()).status).toBe(200);
    expect(await create()).toEqual({ status: 409, body: { error: "role_taken" } });
    expect(await w.storage.findMany("organizationRole", [])).toHaveLength(1);
  });

  it("answers role_taken when a parallel create wins the unique key", async () => {
    // The read inside the transaction misses a row that another create commits
    // after it, as on Postgres with two connections. The unique key then refuses the write.
    let race = false;
    const w = world({ dynamicRoles: {} }, (s) => ({
      ...s,
      transaction: (fn) =>
        s.transaction((tx) =>
          fn({
            ...tx,
            findOne: (model, where) =>
              race && model === "organizationRole"
                ? Promise.resolve(null)
                : tx.findOne(model, where),
          }),
        ),
    }));
    const { organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const create = async () =>
      json(
        await w.auth.handle(
          post(
            `${P}/create`,
            { organizationId, name: "editor", permissions: { member: ["read"] } },
            h,
          ),
        ),
      );
    expect((await create()).status).toBe(200);
    race = true;
    expect(await create()).toEqual({ status: 409, body: { error: "role_taken" } });
    expect(await w.storage.findMany("organizationRole", [])).toHaveLength(1);
  });

  it("answers role_in_use while a member or a pending invitation holds the role", async () => {
    const w = world();
    const { ada, carol, organizationId } = await acme(w);
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "editor",
        rank: 2,
        permissions: { member: ["read"] },
      }),
    );
    const h = bearer(await w.session("ada@example.com"));
    const del = async () =>
      json(await w.auth.handle(post(`${P}/delete`, { organizationId, name: "editor" }, h)));
    const inUse = { status: 409, body: { error: "role_in_use" } };
    // A part of the role string holds it: "member,editor".
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member,editor",
      }),
    );
    const invitation = mustOk(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dave@example.com",
        role: "editor",
      }),
    );
    expect(await del()).toEqual(inUse);
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member",
      }),
    );
    // The member no longer holds it; the pending invitation does.
    expect(await del()).toEqual(inUse);
    mustOk(
      await w.auth.api.revokeInvitation({ user: ada, organizationId, invitationId: invitation.id }),
    );
    expect(await del()).toEqual({ status: 200, body: { ok: true } });
    expect(await w.storage.findMany("organizationRole", [])).toEqual([]);
  });

  it("refuses a role part that no table names, so a later create grants nothing (review probe P1)", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const dave = await w.user("dave@example.com");
    // The admin writes an unknown part onto its own role.
    expect(
      await w.auth.api.updateMemberRole({
        user: bob,
        organizationId,
        userId: bob.id,
        role: "admin,closer",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    // The owner may not grant an unknown part either, by any of the three grant calls.
    expect(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member,closer",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await w.auth.api.addMember({ user: ada, organizationId, userId: dave.id, role: "closer" }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await w.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "eve@example.com",
        role: "viewer,closer",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    // Later the owner creates the role for another person.
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "closer",
        rank: 3,
        permissions: { organization: ["delete"] },
      }),
    );
    const bobCaller = await w.caller(await w.session("bob@example.com"));
    expect(
      await w.auth.hasPermission(bobCaller, {
        organizationId,
        permissions: { organization: ["delete"] },
      }),
    ).toBe(false);
    expect(await w.auth.api.deleteOrganization({ user: bob, organizationId })).toMatchObject({
      ok: false,
      code: "forbidden_rank",
    });
    const roles = (await w.storage.findMany("member", [])).map((m) => m.role).sort();
    expect(roles).toEqual(["admin", "member", "owner"]);
    expect(await w.storage.findMany("invitation", [])).toEqual([]);
  });

  it("refuses at the accept a part that no table names, from an invitation made with dynamicRoles off", async () => {
    // Reachable: an invite with dynamicRoles off may name any part; the app then turns dynamicRoles on.
    const base = createMemoryAdapter();
    const off = world({}, (s) => s, base);
    const { ada, organizationId } = await acme(off);
    const dave = await off.user("dave@example.com");
    mustOk(
      await off.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dave@example.com",
        role: "admin,auditor",
      }),
    );
    const on = world({ dynamicRoles: {} }, (s) => s, base);
    expect(
      await on.auth.api.acceptInvitation({ user: dave, token: off.invitationToken(), ip: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const members = await base.findMany("member", [{ field: "userId", op: "eq", value: dave.id }]);
    expect(members).toEqual([]);
    // The dead invitation is gone, as on every inviter_lost path.
    expect(await base.findMany("invitation", [])).toEqual([]);
  });

  it("answers role_in_use at a create while a member or a pending invitation holds the name", async () => {
    // Reachable: with dynamicRoles off, a grant may name any part. The app then turns dynamicRoles on.
    const base = createMemoryAdapter();
    const off = world({}, (s) => s, base);
    const { ada, carol, organizationId } = await acme(off);
    mustOk(
      await off.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member,closer",
      }),
    );
    const invitation = mustOk(
      await off.auth.api.inviteMember({
        user: ada,
        organizationId,
        email: "dave@example.com",
        role: "viewer,auditor",
      }),
    );
    const on = world({ dynamicRoles: {} }, (s) => s, base);
    const create = (name: string) =>
      on.auth.api.createRole({
        user: ada,
        organizationId,
        name,
        rank: 3,
        permissions: { organization: ["delete"] },
      });
    const inUse = { ok: false, code: "role_in_use" };
    expect(await create("closer")).toMatchObject(inUse);
    expect(await create("auditor")).toMatchObject(inUse);
    expect(await base.findMany("organizationRole", [])).toEqual([]);
    const carolCaller = await on.caller(await on.session("carol@example.com"));
    expect(
      await on.auth.hasPermission(carolCaller, {
        organizationId,
        permissions: { organization: ["delete"] },
      }),
    ).toBe(false);
    // Once no one holds the name, the create answers ok.
    mustOk(
      await on.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member",
      }),
    );
    expect(await create("closer")).toMatchObject({ ok: true, value: { name: "closer" } });
    mustOk(
      await on.auth.api.revokeInvitation({
        user: ada,
        organizationId,
        invitationId: invitation.id,
      }),
    );
    expect(await create("auditor")).toMatchObject({ ok: true, value: { name: "auditor" } });
  });

  it("answers role_limit at the cap", async () => {
    const w = world({ dynamicRoles: { maxPerOrganization: 2 } });
    const { organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const create = async (name: string) =>
      json(
        await w.auth.handle(
          post(`${P}/create`, { organizationId, name, permissions: { member: ["read"] } }, h),
        ),
      );
    expect((await create("one")).status).toBe(200);
    expect((await create("two")).status).toBe(200);
    expect(await create("three")).toEqual({ status: 409, body: { error: "role_limit" } });
    expect((await w.storage.findMany("organizationRole", [])).map((r) => r.name).sort()).toEqual([
      "one",
      "two",
    ]);
  });

  it("a role row with a bad shape grants nothing", async () => {
    const w = world();
    const { ada, bob, carol, organizationId } = await acme(w);
    const make = async (name: string) =>
      mustOk(
        await w.auth.api.createRole({
          user: ada,
          organizationId,
          name,
          rank: 2,
          permissions: { member: ["read"], invitation: ["read"] },
        }),
      );
    const editor = await make("editor");
    const ranked = await make("ranked");
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "editor",
      }),
    );
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: bob.id,
        role: "member,ranked",
      }),
    );
    // The shim's in-place table holds rows that Better Auth wrote; core must survive any text.
    await w.storage.update("organizationRole", [{ field: "id", op: "eq", value: editor.id }], {
      permissions: "{",
    });
    // The owner rank: a row may not hold it.
    await w.storage.update("organizationRole", [{ field: "id", op: "eq", value: ranked.id }], {
      rank: 4,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const carolCaller = await w.caller(await w.session("carol@example.com"));
    for (const permissions of [{ member: ["read"] }, { invitation: ["read"] }, { ac: ["read"] }])
      expect(await w.auth.hasPermission(carolCaller, { organizationId, permissions })).toBe(false);
    expect(warn.mock.calls).toEqual([
      [`authtempo: role row invalid ${editor.id}`],
      [`authtempo: role row invalid ${editor.id}`],
      [`authtempo: role row invalid ${editor.id}`],
    ]);
    warn.mockClear();
    // Bob keeps the member part alone: the list answers 200, and the bad rank adds nothing.
    const bobToken = await w.session("bob@example.com");
    const list = await w.auth.handle(
      get(`/auth/organizations/members?organizationId=${organizationId}`, bearer(bobToken)),
    );
    expect(list.status).toBe(200);
    expect(warn.mock.calls).toEqual([[`authtempo: role row invalid ${ranked.id}`]]);
    expect(await w.auth.permissionsOf(await w.caller(bobToken), organizationId)).toEqual({
      ok: true,
      value: { role: "member,ranked", permissions: { member: ["read"], ac: ["read"] } },
    });
    // The list leaves out both rows, and the get answers not_found for each.
    expect(await w.auth.api.listRoles({ user: ada, organizationId })).toEqual({
      ok: true,
      value: [],
    });
    expect(await w.auth.api.getRole({ user: ada, organizationId, name: "editor" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("applies a narrow at the next request", async () => {
    const w = world({
      dynamicRoles: {},
      statements: { project: ["read", "write"] },
      roles: {
        member: { rank: 1, permissions: { member: ["read"] } },
        admin: { rank: 3, permissions: { member: ["read", "create", "update", "delete"] } },
        owner: {
          rank: 4,
          permissions: {
            organization: ["update", "delete"],
            member: ["read", "create", "update", "delete"],
            ac: ["read", "create", "update", "delete"],
            project: ["read", "write"],
          },
        },
      },
    });
    const { ada, carol, organizationId } = await acme(w);
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "dev",
        rank: 2,
        permissions: { project: ["read", "write"] },
      }),
    );
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "dev",
      }),
    );
    const c = await w.caller(await w.session("carol@example.com"));
    const write = { organizationId, permissions: { project: ["write"] } };
    expect(await w.auth.hasPermission(c, write)).toBe(true);
    mustOk(
      await w.auth.api.updateRole({
        user: ada,
        organizationId,
        name: "dev",
        permissions: { project: ["read"] },
      }),
    );
    expect(await w.auth.hasPermission(c, write)).toBe(false);
    expect(
      await w.auth.hasPermission(c, { organizationId, permissions: { project: ["read"] } }),
    ).toBe(true);
  });

  it("needs a fresh session for the three writes", async () => {
    const w = world();
    const { ada, organizationId } = await acme(w);
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "editor",
        permissions: { member: ["read"] },
      }),
    );
    const h = bearer(await w.session("ada@example.com"));
    // Two days: past session.freshMinutes (1440), inside the ttl of 30 days.
    w.clock.advance(2 * DAY);
    const stale = { status: 403, body: { error: "session_not_fresh" } };
    const write = async (path: string, body: unknown) =>
      json(await w.auth.handle(post(`${P}/${path}`, body, h)));
    expect(
      await write("create", { organizationId, name: "lead", permissions: { member: ["read"] } }),
    ).toEqual(stale);
    expect(await write("update", { organizationId, name: "editor", rank: 2 })).toEqual(stale);
    expect(await write("delete", { organizationId, name: "editor" })).toEqual(stale);
    const list = await json(await w.auth.handle(get(`${P}?organizationId=${organizationId}`, h)));
    expect(list.status).toBe(200);
    expect(list.body.roles.map((r: { name: string; rank: number }) => [r.name, r.rank])).toEqual([
      ["editor", 1],
    ]);
    expect(
      (await w.auth.handle(get(`${P}/get?organizationId=${organizationId}&name=editor`, h))).status,
    ).toBe(200);
  });

  it("mounts no role route with dynamicRoles off", async () => {
    let roleReads = 0;
    const w = world({}, (s) => ({
      ...s,
      findMany(model, where, options) {
        if (model === "organizationRole") roleReads++;
        return s.findMany(model, where, options);
      },
    }));
    const { ada, carol, organizationId } = await acme(w);
    const h = bearer(await w.session("ada@example.com"));
    const answers = [
      await w.auth.handle(get(`${P}?organizationId=${organizationId}`, h)),
      await w.auth.handle(get(`${P}/get?organizationId=${organizationId}&name=editor`, h)),
      await w.auth.handle(
        post(
          `${P}/create`,
          { organizationId, name: "editor", permissions: { member: ["read"] } },
          h,
        ),
      ),
      await w.auth.handle(post(`${P}/update`, { organizationId, name: "editor" }, h)),
      await w.auth.handle(post(`${P}/delete`, { organizationId, name: "editor" }, h)),
    ];
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    const input = { user: ada, organizationId, name: "editor" };
    const notFound = { ok: false, code: "not_found" };
    expect(await w.auth.api.listRoles({ user: ada, organizationId })).toMatchObject(notFound);
    expect(await w.auth.api.getRole(input)).toMatchObject(notFound);
    expect(
      await w.auth.api.createRole({ ...input, permissions: { member: ["read"] } }),
    ).toMatchObject(notFound);
    expect(await w.auth.api.updateRole(input)).toMatchObject(notFound);
    expect(await w.auth.api.deleteRole(input)).toMatchObject(notFound);
    // A part that the config does not name grants nothing, and no role row is read.
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member,editor",
      }),
    );
    const c = await w.caller(await w.session("carol@example.com"));
    expect(
      await w.auth.hasPermission(c, { organizationId, permissions: { member: ["read"] } }),
    ).toBe(true);
    expect(roleReads).toBe(0);
  });

  it("reads the role rows once per check, with dynamicRoles on", async () => {
    let roleReads = 0;
    const w = world({ dynamicRoles: {} }, (s) => ({
      ...s,
      findMany(model, where, options) {
        if (model === "organizationRole") roleReads++;
        return s.findMany(model, where, options);
      },
    }));
    const { ada, carol, organizationId } = await acme(w);
    for (const name of ["editor", "ghost"])
      mustOk(
        await w.auth.api.createRole({
          user: ada,
          organizationId,
          name,
          permissions: { member: ["read"] },
        }),
      );
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: carol.id,
        role: "member,editor,ghost,editor",
      }),
    );
    const c = await w.caller(await w.session("carol@example.com"));
    roleReads = 0;
    expect(
      await w.auth.hasPermission(c, { organizationId, permissions: { member: ["read"] } }),
    ).toBe(true);
    expect(roleReads).toBe(1);
    // A role string of config parts only reads no row.
    roleReads = 0;
    const a = await w.caller(await w.session("ada@example.com"));
    expect(
      await w.auth.hasPermission(a, { organizationId, permissions: { member: ["read"] } }),
    ).toBe(true);
    expect(roleReads).toBe(0);
  });

  it("keeps the last owner through a role edit", async () => {
    const w = world();
    const { ada, organizationId } = await acme(w);
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "lead",
        rank: 3,
        permissions: { member: ["read"] },
      }),
    );
    expect(
      await w.auth.api.updateRole({ user: ada, organizationId, name: "lead", rank: 4 }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    // The last owner cannot step down to the dynamic role.
    expect(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: ada.id,
        role: "lead",
      }),
    ).toMatchObject({ ok: false, code: "last_owner" });
    const owners = (await w.storage.findMany("member", [])).filter((m) => m.role === "owner");
    expect(owners.map((m) => m.userId)).toEqual([ada.id]);
    expect(await w.auth.api.getRole({ user: ada, organizationId, name: "lead" })).toMatchObject({
      ok: true,
      value: { rank: 3 },
    });
  });

  it("lets a member with a dynamic role grant a role at or below its rank", async () => {
    const w = world();
    const { ada, bob, organizationId } = await acme(w);
    mustOk(
      await w.auth.api.createRole({
        user: ada,
        organizationId,
        name: "manager",
        rank: 2,
        permissions: { member: ["read", "create"], ac: ["read"] },
      }),
    );
    mustOk(
      await w.auth.api.updateMemberRole({
        user: ada,
        organizationId,
        userId: bob.id,
        role: "manager",
      }),
    );
    const eve = await w.user("eve@example.com");
    const fay = await w.user("fay@example.com");
    const add = (userId: string, role: string) =>
      w.auth.api.addMember({ user: bob, organizationId, userId, role });
    expect(await add(eve.id, "admin")).toMatchObject({ ok: false, code: "forbidden_rank" });
    // member has rank 2, as manager does, and holds member:read and ac:read.
    expect(await add(eve.id, "member")).toMatchObject({ ok: true, value: { role: "member" } });
    expect(await add(fay.id, "viewer")).toMatchObject({ ok: true, value: { role: "viewer" } });
  });
});

describe("the dynamicRoles config (plan 12k Task 4)", () => {
  const resolve = (dynamicRoles: unknown) =>
    resolveConfig({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      // A JS caller can pass any value; the cast reaches the runtime checks.
      organizations:
        dynamicRoles === undefined ? {} : { dynamicRoles: dynamicRoles as DynamicRolesConfig },
    }).organizations?.dynamicRoles;

  it("takes maxPerOrganization from 1 to 1000, default 50, and no other key", () => {
    expect(resolve(undefined)).toBeNull();
    expect(resolve({})).toEqual({ maxPerOrganization: 50 });
    expect(resolve({ maxPerOrganization: 1 })).toEqual({ maxPerOrganization: 1 });
    expect(resolve({ maxPerOrganization: 1000 })).toEqual({ maxPerOrganization: 1000 });
    for (const bad of [0, 1001, 1.5, "5", null])
      expect(() => resolve({ maxPerOrganization: bad }), String(bad)).toThrow(
        "organizations.dynamicRoles.maxPerOrganization must be an integer from 1 to 1000",
      );
    expect(() => resolve({ cache: true })).toThrow(
      "organizations.dynamicRoles.cache is not an option; core has maxPerOrganization",
    );
    expect(() => resolve(true)).toThrow("organizations.dynamicRoles must be an object");
  });
});
