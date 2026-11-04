import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  API,
  APP,
  acme,
  call,
  count,
  counting,
  GROUP_URN,
  limits,
  make,
  members,
  PATCH_CAP,
  patch,
  ROLE_CAP,
  resetWorld,
  sent,
  users,
} from "./scim-groups-world.js";

// The queries of the SCIM Groups routes on the D1 binding (plan 12d Task
// 11, ruling 25 N4, ruling 53 P4). D1 Free allows 50 queries per
// invocation (D1 limits page updated 21 April 2026, read 2026-10-21). Each
// request runs as the worker-d1 setup serves it: the D1 limiter and the D1
// adapter on one counting view of the binding.
//
// The worst setup: `scim.groups: "both"`, so each group has a team; a role
// map with a dynamic role; the member role hooks, which read the users; and
// `membersPerTeam`, which adds the count. The caps of groups.ts come from
// these counts: PATCH_MEMBERS_MAX for the members of one write, and
// GROUP_ROLE_USERS_MAX for the role recompute of a rename or a delete.
//
// The list page at 10000 member rows is a named measure, out of the default
// test gate: measure/scim-groups-list.measure.ts (fix wave of plan 12i, item 3).

beforeEach(resetWorld);

describe("the SCIM Groups on D1 (plan 12d Task 11, ruling 25 N4)", () => {
  // It makes 3001 SCIM users first. Its lowest time in the logs is 30.9 s. In the 20 evidence
  // runs of 2026-10-30 to 2026-11-03 it passed in up to 84.4 s, at sampled peak load 36 to 56.
  // It timed out at 120 s once, at 122.5 s, in a release rehearsal of 2026-10-30 (peak load 35).
  it("keeps each route at the member cap inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const ids = await users(token, 3 * PATCH_CAP + 1);
    const first = ids.slice(0, PATCH_CAP);
    const second = ids.slice(PATCH_CAP, 2 * PATCH_CAP);
    const third = ids.slice(2 * PATCH_CAP, 3 * PATCH_CAP);
    const spare = ids[3 * PATCH_CAP] ?? "";
    // The create of a mapped group with a team and the most members of one write.
    const create = await call(
      token,
      "POST",
      "/Groups",
      { schemas: [GROUP_URN], displayName: "Admins", members: members(first) },
      true,
    );
    expect(create.status).toBe(201);
    const id = String(create.body.id);
    expect(await count("SELECT count(*) AS n FROM ta_team_member")).toBe(PATCH_CAP);
    // One past the cap: refused before any write.
    const over = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "add", path: "members", value: members([...second, spare]) }),
      true,
    );
    expect([over.status, over.body.scimType]).toEqual([400, "invalidValue"]);
    // The worst PATCH: adds and a removal, so two role changes and both team writes.
    const mixed = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch(
        { op: "add", path: "members", value: members(second.slice(0, PATCH_CAP - 1)) },
        { op: "remove", path: `members[value eq "${first[0]}"]` },
      ),
      true,
    );
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(204);
    const adds = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "add", path: "members", value: members(third) }),
      true,
    );
    expect(adds.status).toBe(204);
    const get = await call(token, "GET", `/Groups/${id}`, undefined, true);
    const list = await call(token, "GET", "/Groups?excludedAttributes=members", undefined, true);
    const check = await call(
      token,
      "GET",
      `/Groups?filter=${encodeURIComponent(`id eq "${id}" and members[value eq "${third[0]}"]`)}&excludedAttributes=members`,
      undefined,
      true,
    );
    expect(check.body.totalResults).toBe(1);
    const counts = {
      create: create.queries,
      over: over.queries,
      mixed: mixed.queries,
      adds: adds.queries,
      get: get.queries,
      list: list.queries,
      check: check.queries,
    };
    // Measured on the binding; see the ledger of plan 12d Task 11.
    expect(counts).toEqual(MEASURED_CAP);
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(50);
  }, 300_000);

  it("keeps the rename and the delete of a mapped group at the role cap inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const ids = await users(token, ROLE_CAP);
    const made = await call(token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName: "Admins",
      members: members(ids.slice(0, PATCH_CAP)),
    });
    const id = String(made.body.id);
    for (let i = PATCH_CAP; i < ROLE_CAP; i += PATCH_CAP) {
      const r = await call(
        token,
        "PATCH",
        `/Groups/${id}`,
        patch({ op: "add", path: "members", value: members(ids.slice(i, i + PATCH_CAP)) }),
      );
      expect(r.status).toBe(204);
    }
    expect(await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'")).toBe(ROLE_CAP);
    // A rename out of the map: each member falls back to the default role.
    const rename = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "replace", path: "displayName", value: "Former" }),
      true,
    );
    expect(rename.status).toBe(204);
    expect(await count("SELECT count(*) AS n FROM ta_member WHERE role = 'member'")).toBe(ROLE_CAP);
    // A rename into the map: each member gets the role again.
    const back = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "replace", path: "displayName", value: "Admins" }),
      true,
    );
    expect(back.status).toBe(204);
    const gone = await call(token, "DELETE", `/Groups/${id}`, undefined, true);
    expect(gone.status).toBe(204);
    expect(await count("SELECT count(*) AS n FROM ta_member WHERE role = 'member'")).toBe(ROLE_CAP);
    expect(await count("SELECT count(*) AS n FROM ta_team")).toBe(0);
    const counts = { rename: rename.queries, back: back.queries, delete: gone.queries };
    expect(counts).toEqual(MEASURED_ROLES);
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(50);
  }, 300_000);

  it("keeps the reactivate of a User in mapped groups inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const [ada] = await users(token, 1);
    for (const name of ["Admins", "Web"]) {
      const r = await call(token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: name,
        members: members([ada ?? ""]),
      });
      expect(r.status).toBe(201);
    }
    const off = await call(
      token,
      "PATCH",
      `/Users/${ada}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    const on = await call(
      token,
      "PATCH",
      `/Users/${ada}`,
      patch({ op: "replace", path: "active", value: true }),
      true,
    );
    expect(on.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'")).toBe(1);
    // A reactivate gives back the role, not the teams (ruling 53 P7).
    expect(await count("SELECT count(*) AS n FROM ta_team_member")).toBe(0);
    expect({ reactivate: on.queries }).toEqual(MEASURED_REACTIVATE);
    expect(on.queries).toBeLessThanOrEqual(50);
  }, 120_000);

  it("refuses a role change past the budget with a small undo, inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { organizationId, owner, token } = await acme(setup);
    // More role pairs than the worst PATCH: the dynamic roles r1 to r4 beside web, and each
    // pair of them, each with its own group. Since ruling 84 an update of up to 1000 members
    // is one statement, so the role pairs, not the members, fill the budget.
    for (const name of ["r1", "r2", "r3", "r4"]) {
      const role = await setup.api.createRole({
        user: owner,
        organizationId,
        name,
        permissions: { member: ["read"] },
      });
      if (!role.ok) throw new Error(role.code);
    }
    const single = ["web", "r1", "r2", "r3", "r4"];
    const roles = [
      ...single,
      ...single.flatMap((x, i) => single.slice(i + 1).map((y) => `${x},${y}`)),
    ];
    const names = roles.map((_, i) => `G${i}`);
    const map = await setup.api.scim?.setRoleMap({
      actor: APP,
      organizationId,
      map: { Admins: "admin", ...Object.fromEntries(names.map((n, i) => [n, roles[i] ?? ""])) },
    });
    if (!map?.ok) throw new Error(`no role map: ${JSON.stringify(map)}`);
    const ids = await users(token, PATCH_CAP);
    const gone = ids[0] ?? "";
    // 999 members in 15 groups of 66 or 67 members.
    const per = Math.ceil((PATCH_CAP - 1) / names.length);
    const made: string[] = [];
    for (const [i, name] of ["Admins", ...names].entries()) {
      const list = i === 0 ? [gone] : ids.slice(1 + (i - 1) * per, 1 + i * per);
      const r = await call(token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: name,
        members: members(list),
      });
      expect(r.status).toBe(201);
      made.push(String(r.body.id));
    }
    const admins = made[0] ?? "";
    const state = async () => ({
      groups: await count("SELECT count(*) AS n FROM ta_scim_group_member"),
      teams: await count("SELECT count(*) AS n FROM ta_team_member"),
      versions: await count("SELECT sum(version) AS n FROM ta_scim_group"),
      admins: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'"),
      roles: await count("SELECT count(DISTINCT role) AS n FROM ta_member"),
      audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
    });
    const before = await state();
    // Sixteen role changes in one write: each of the 15 roles to admin, and admin to member.
    // Their updates and the team writes do not fit the budget, so the write stops.
    const refused = await call(
      token,
      "PATCH",
      `/Groups/${admins}`,
      patch(
        { op: "add", path: "members", value: members(ids.slice(1, PATCH_CAP)) },
        { op: "remove", path: `members[value eq "${gone}"]` },
      ),
      true,
    );
    expect([refused.status, refused.body?.scimType]).toEqual([400, "invalidValue"]);
    expect(refused.body.detail).toBe(
      "the role change of this request does not fit one request; change fewer members in each request",
    );
    expect(await state()).toEqual(before);
    expect({ refused: refused.queries }).toEqual(MEASURED_TOO_LARGE);
    expect(refused.queries).toBeLessThanOrEqual(50);
  }, 300_000);

  it("refuses a team member add past membersPerTeam at the member cap and undoes every write, inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const ids = await users(token, 2 * PATCH_CAP);
    const first = ids.slice(0, PATCH_CAP);
    const second = ids.slice(PATCH_CAP);
    const made = await call(token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName: "Admins",
      members: members(first),
    });
    expect(made.status).toBe(201);
    const id = String(made.body.id);
    const state = async () => ({
      groups: await count("SELECT count(*) AS n FROM ta_scim_group_member"),
      teams: await count("SELECT count(*) AS n FROM ta_team_member"),
      versions: await count("SELECT sum(version) AS n FROM ta_scim_group"),
      admins: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'"),
      sessions: await count("SELECT count(*) AS n FROM ta_session"),
      audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
    });
    const before = await state();
    // The team holds 1000 members. The team member add comes after the scimGroupMember
    // writes, the role updates, and the team member delete, so the undo restores each.
    limits.membersPerTeam = PATCH_CAP;
    const refused = await call(
      token,
      "PATCH",
      `/Groups/${id}`,
      patch(
        { op: "add", path: "members", value: members(second.slice(0, PATCH_CAP - 1)) },
        { op: "remove", path: `members[value eq "${first[0]}"]` },
      ),
      true,
    );
    expect([refused.status, refused.body?.detail]).toEqual([409, "team_member_limit"]);
    expect(await state()).toEqual(before);
    expect({ refused: refused.queries }).toEqual(MEASURED_TEAM_LIMIT);
    expect(refused.queries).toBeLessThanOrEqual(50);
  }, 300_000);
});

/**
 * The counts of the run on the binding, 2026-10-22, with the token write of
 * `lastUsedAt` in each call (the worst route step). `mixed` is the worst
 * write at PATCH_MEMBERS_MAX: 8 adds and 1 removal of a mapped group with a
 * team, so two role changes, a team member removal, and the team member
 * adds. The tenth value (`over`) answers 400 after 6 queries, before any
 * write. `back` is the worst write at GROUP_ROLE_USERS_MAX: a rename into
 * the map gives each of 250 members the mapped role.
 *
 * Measured again on 2026-10-24 for ruling 57 of plan 12d, with
 * `createMany` and PATCH_MEMBERS_MAX 61: `mixed` is 60 adds and 1 removal,
 * 50 queries. The 62nd value (`over`) answers 400 after 6 queries. The
 * other counts are the same numbers as at 9 members: the inserts of 61
 * rows cost as few queries as the creates of 9 rows did.
 *
 * Measured again on 2026-10-24 for ruling 84 of plan 12d, with the list
 * forms and PATCH_MEMBERS_MAX 1000: `mixed` is 999 adds and 1 removal, 41
 * queries. A read, a delete, and an update of up to 1000 ids is one
 * statement, and an insert of 1000 rows is one per chunk of
 * `rowChunks`. The 1001st value
 * (`over`) answers 400 after 6 queries. The rename and the delete of a
 * mapped group of 1000 members (GROUP_ROLE_USERS_MAX) send 21, 22, and 24.
 * The scratch measure of the same day at 1, 61, 500, and 1000 values:
 * create 26, 26, 28, 32; mixed 26, 35, 37, 41.
 *
 * Measured again on 2026-10-24 for ruling 85 of plan 12d: an insert chunk
 * of `rowChunks` takes two thirds of the list bytes, not half. So 1000 rows
 * take three statements, not four: create 30, mixed 39, adds 33.
 */
const MEASURED_CAP = {
  create: 30,
  over: 6,
  mixed: 39,
  adds: 33,
  get: 6,
  list: 5,
  check: 6,
};
const MEASURED_ROLES = { rename: 21, back: 22, delete: 24 };
/**
 * Measured again on 2026-10-22 for ruling 59 of plan 12d, one test file
 * alone, at a load of 6 to 12. The reactivate reads the role of its
 * groups again after its user hold (M2): 4 queries more than the 28 of
 * Task 11. Ruling 74 M2 adds the read of the domain claim of the current
 * address: 33 on 2026-10-24.
 */
const MEASURED_REACTIVATE = { reactivate: 33 };
/**
 * The refusal of a write whose role change does not fit (ruling 59 of plan
 * 12d). The check comes before the scimGroupMember writes, so the undo
 * restores the group row and the team row only. Before this fix, the meter
 * did not count the scimGroupMember writes, and the same write passed with
 * 51 queries. Since ruling 57 the write of 9 values fits, so the scene
 * sends 61 values with two updates of the role member to admin: 23 queries
 * on 2026-10-24.
 *
 * Since ruling 84 of plan 12d one update takes up to 1000 members. So the
 * scene sends 1000 values with 16 role pairs: 20 queries on 2026-10-24.
 */
const MEASURED_TOO_LARGE = { refused: 20 };
/**
 * The refusal of a team member add past `membersPerTeam`, at the member
 * cap (ruling 84 of plan 12d). It comes after the scimGroupMember writes,
 * the role updates, and the team member delete. The D1 undo restores the
 * rows of each write with one statement per list: 45 queries in all on
 * 2026-10-24.
 *
 * Ruling 85: the undo of the insert chunks of one model is one delete, and
 * 1000 rows take three inserts. 41 on 2026-10-24.
 *
 * Ruling 86: the session end of the leaver comes after the audit row, so
 * the refusal comes before it. 39 on 2026-10-24.
 */
const MEASURED_TEAM_LIMIT = { refused: 39 };

describe("the SCIM Groups of an organization delete on D1 (ruling 74 of plan 12d)", () => {
  it("deletes an organization with 500 groups and their member rows inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { organizationId, token } = await acme(setup);
    const [ada] = await users(token, 1);
    for (let i = 0; i < GROUPS; i++) {
      const r = await call(token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: `Group ${i}`,
        members: members([ada ?? ""]),
      });
      expect(r.status).toBe(201);
    }
    expect(await count("SELECT count(*) AS n FROM ta_scim_group_member")).toBe(GROUPS);
    // The owner's session, from a magic link of the setup engine.
    await setup.api.requestMagicLink({ email: "owner@acme.example", ip: null });
    const text = sent.filter((m) => m.to === "owner@acme.example").at(-1)?.text ?? "";
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const signed = await setup.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!signed.ok || !("token" in signed.value)) throw new Error("no session");
    const { db: view, c } = counting(env.DB);
    const res = await make(view, true).handle(
      new Request(`${API}/auth/organizations/delete`, {
        method: "POST",
        headers: {
          cookie: `__Host-tempo_session=${signed.value.token}`,
          "content-type": "application/json",
          origin: API,
        },
        body: JSON.stringify({ organizationId }),
      }),
    );
    expect(res.status, await res.text()).toBe(200);
    for (const table of [
      "ta_organization",
      "ta_scim_group",
      "ta_scim_group_member",
      "ta_scim_user",
    ])
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect({ delete: c.n }).toEqual(MEASURED_ORGANIZATION_DELETE);
    expect(c.n).toBeLessThanOrEqual(50);
  }, 300_000);

  it("deletes the sole member of an organization with groups inside 50 queries, and the sweep takes the groups", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const [ada] = await users(token, 1);
    for (let i = 0; i < ACCOUNT_DELETE_GROUPS; i++) {
      const r = await call(token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: `Group ${i}`,
        members: members([ada ?? ""]),
      });
      expect(r.status).toBe(201);
    }
    // The deactivate removes ada's member row, so the owner is the only member.
    const off = await call(
      token,
      "PATCH",
      `/Users/${ada}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    await setup.api.requestMagicLink({ email: "owner@acme.example", ip: null });
    const text = sent.filter((m) => m.to === "owner@acme.example").at(-1)?.text ?? "";
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const signed = await setup.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!signed.ok || !("token" in signed.value)) throw new Error("no session");
    const session = await setup.api.getSession(signed.value.token);
    if (!session) throw new Error("no session");
    const { db: view, c } = counting(env.DB);
    const done = await make(view, true).api.user.delete({ session, ip: null, userAgent: null });
    expect(done).toEqual({ ok: true, value: { ok: true } });
    expect(await count("SELECT count(*) AS n FROM ta_organization")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM ta_user")).toBe(1);
    // The groups wait for the sweep, one chunk of 50 in each sweep.
    const sweeps: number[] = [];
    while (
      await count("SELECT count(*) AS n FROM ta_verification WHERE purpose = 'organization-rest'")
    ) {
      if (sweeps.length >= 10) throw new Error("the sweep makes no progress");
      const { db: next, c: d } = counting(env.DB);
      await make(next, true).api.sweepExpired();
      sweeps.push(d.n);
    }
    for (const table of ["ta_scim_group", "ta_scim_group_member", "ta_scim_user"])
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect({ accountDelete: c.n, sweeps }).toEqual(MEASURED_ACCOUNT_DELETE);
    expect(Math.max(c.n, ...sweeps)).toBeLessThanOrEqual(50);
  }, 300_000);
});

/**
 * The organization delete with 100 SCIM Groups (ruling 74 of plan 12d).
 * The group read, the scimGroupMember delete, and the scimGroup delete add
 * 3 queries to the delete. The count does not grow with the groups: one
 * delete binds the 100 ids.
 */
// The route reads the session once since ruling 78 of plan 12d (2026-10-24): 31, was 32.
const MEASURED_ORGANIZATION_DELETE = { delete: 31 };
/**
 * The account delete of the sole member of an organization with SCIM
 * Groups (ruling 78 of plan 12d, 2026-10-24). Before, it answered
 * delete_too_large in 14 queries. The act takes the organization, its
 * SCIM token, and its member rows, and leaves the groups to the sweep. A
 * sweep takes 50 groups at a time, so 120 groups take three sweeps.
 */
const ACCOUNT_DELETE_GROUPS = 120;
// Plan 12f2 ends the own sessions of the delete in a page (ruling 1 of plan 12f2, B1). With
// no session.afterEnd hook the page sends 2 queries more than endSessions: the run of
// 2026-10-25 at the move of 12f2 onto main gives 38, was 36.
const MEASURED_ACCOUNT_DELETE = { accountDelete: 38, sweeps: [24, 24, 34] };
const GROUPS = 500;

/**
 * A view of `db` that runs `act` once, just before the first statement
 * whose SQL `match` takes, alone or in a batch. `match` sees each statement
 * in the order of the run. `act` writes through `env.DB`, as another
 * request does, so the counts of the view do not hold it.
 */
function trapped(db: D1Database, match: (sql: string) => boolean, act: () => Promise<void>) {
  let armed = true;
  const sqlOf = new WeakMap<object, string>();
  const fire = async (sql: string) => {
    if (armed && match(sql)) {
      armed = false;
      await act();
    }
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v), sql);
        const x = Reflect.get(a, b);
        if (b === "run" || b === "all" || b === "first" || b === "raw")
          return async (...args: unknown[]) => {
            await fire(sql);
            return (x as (...y: unknown[]) => unknown).apply(a, args);
          };
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
    sqlOf.set(p, sql);
    return p;
  };
  const view = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch")
        return async (st: D1PreparedStatement[]) => {
          for (const s of st) await fire(sqlOf.get(s) ?? "");
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: view as D1Database, fired: () => !armed };
}

/** The row of `table` by id, to put back after a scene deletes it. */
async function saved(table: string, id: string) {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) throw new Error(`no row ${id} in ${table}`);
  const cols = Object.keys(row);
  return () =>
    env.DB.prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
      .bind(...cols.map((c) => row[c]))
      .run();
}

describe("the late conflicts of the SCIM Groups on D1 at the member cap (ruling 85 of plan 12d)", () => {
  it("undoes each write of a late conflict inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { organizationId, owner, token } = await acme(setup);
    const ids = await users(token, 3 * PATCH_CAP);
    const first = ids.slice(0, PATCH_CAP);
    const second = ids.slice(PATCH_CAP, 2 * PATCH_CAP);
    const third = ids.slice(2 * PATCH_CAP);
    const userOf = async (scimUserId: string) =>
      String(
        await env.DB.prepare("SELECT user_id AS n FROM ta_scim_user WHERE id = ?")
          .bind(scimUserId)
          .first("n"),
      );
    const state = async () => ({
      groups: await count("SELECT count(*) AS n FROM ta_scim_group"),
      rows: await count("SELECT count(*) AS n FROM ta_scim_group_member"),
      teams: await count("SELECT count(*) AS n FROM ta_team"),
      teamRows: await count("SELECT count(*) AS n FROM ta_team_member"),
      versions: await count("SELECT coalesce(sum(version), 0) AS n FROM ta_scim_group"),
      names: await count("SELECT count(*) AS n FROM ta_team WHERE name = 'Admins'"),
      admins: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'"),
      members: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'member'"),
      sessions: await count("SELECT count(*) AS n FROM ta_session WHERE active_team_id IS NULL"),
      audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
    });
    /**
     * One request on a view that runs `act` before the first statement that
     * `match` takes. It must answer 409, and the state must equal the state
     * before, once `undo` puts back the row that `act` changed.
     */
    const late = async (
      method: string,
      path: string,
      body: unknown,
      match: (sql: string) => boolean,
      act: () => Promise<() => Promise<unknown>>,
    ) => {
      const before = await state();
      await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
      const { db: view, c } = counting(env.DB);
      let undo: () => Promise<unknown> = async () => {};
      const trap = trapped(view, match, async () => {
        undo = await act();
      });
      const res = await make(trap.db, true).handle(
        new Request(`${API}/auth/scim/v2${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
          body: JSON.stringify(body),
        }),
      );
      const text = await res.text();
      expect([trap.fired(), res.status, text.slice(0, 300)], path).toEqual([
        true,
        409,
        expect.any(String),
      ]);
      // A late conflict answers the race detail with no scimType (decision 1 of plan 12o).
      expect([res.status, JSON.parse(text)], path).toStrictEqual([
        409,
        {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "409",
          detail: "Another request changed this user at the same time. Send the request again.",
        },
      ]);
      await undo();
      expect(await state()).toEqual(before);
      return c.n;
    };
    /** After the first team member insert: the read of usersStay, the last read of the write. */
    const atUsersStay = () => {
      let seen = false;
      return (sql: string) => {
        if (sql.startsWith("INSERT INTO ta_team_member")) seen = true;
        return seen && sql.startsWith("SELECT") && sql.includes("FROM ta_user WHERE");
      };
    };
    /** After the first scimGroupMember insert: the read of the Users of the added members. */
    const atScimUsers = () => {
      let seen = false;
      return (sql: string) => {
        if (sql.startsWith("INSERT INTO ta_scim_group_member")) seen = true;
        return seen && sql.startsWith("SELECT") && sql.includes("FROM ta_scim_user WHERE");
      };
    };
    /** The account delete of a person, between the reads and the write. */
    const dropUser = (scimUserId: string) => async () => {
      const id = await userOf(scimUserId);
      const back = await saved("ta_user", id);
      await env.DB.prepare("DELETE FROM ta_user WHERE id = ?").bind(id).run();
      return back;
    };
    const dropScimUser = (scimUserId: string) => async () => {
      const back = await saved("ta_scim_user", scimUserId);
      await env.DB.prepare("DELETE FROM ta_scim_user WHERE id = ?").bind(scimUserId).run();
      return back;
    };
    const body = (list: readonly string[]) => ({
      schemas: [GROUP_URN],
      displayName: "Admins",
      members: members(list),
    });
    const counts: Record<string, number> = {};
    // The create of a mapped group with a team and 1000 members.
    counts.create = await late(
      "POST",
      "/Groups",
      body(first),
      atUsersStay(),
      dropUser(first[500] ?? ""),
    );
    const made = await call(token, "POST", "/Groups", body(first));
    expect(made.status).toBe(201);
    const id = String(made.body.id);
    // Each member of the group signed in through the connection and acts in its team. A
    // person who leaves the team then loses the active team of each session: one more
    // undo statement. The rows copy the session of the owner, as a sign-in writes them.
    const teamId = String(
      await env.DB.prepare("SELECT team_id AS n FROM ta_scim_group WHERE id = ?")
        .bind(id)
        .first("n"),
    );
    const cols = (
      await env.DB.prepare("SELECT name FROM pragma_table_info('ta_session')").all()
    ).results.map((r) => String(r.name));
    const pick = (c: string) =>
      c === "id"
        ? "'s-' || u.id"
        : c === "user_id"
          ? "u.user_id"
          : c === "token_hash"
            ? "'t-' || u.id"
            : c === "active_organization_id"
              ? "u.organization_id"
              : c === "active_team_id"
                ? "?2"
                : `s.${c}`;
    await env.DB.prepare(
      `INSERT INTO ta_session (${cols.join(", ")}) SELECT ${cols.map(pick).join(", ")} FROM ta_session s, ta_scim_user u WHERE s.id = (SELECT min(id) FROM ta_session) AND u.id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(first), teamId)
      .run();
    expect(
      await count("SELECT count(*) AS n FROM ta_session WHERE active_team_id IS NOT NULL"),
    ).toBe(PATCH_CAP);
    const mixed = patch(
      { op: "add", path: "members", value: members(second.slice(0, PATCH_CAP - 1)) },
      { op: "remove", path: `members[value eq "${first[0]}"]` },
    );
    // The worst PATCH of the review (MA-1): 999 adds and 1 removal.
    counts.mixed = await late(
      "PATCH",
      `/Groups/${id}`,
      mixed,
      atUsersStay(),
      dropUser(second[5] ?? ""),
    );
    counts.mixedScimUser = await late(
      "PATCH",
      `/Groups/${id}`,
      mixed,
      atScimUsers(),
      dropScimUser(second[5] ?? ""),
    );
    counts.adds = await late(
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "add", path: "members", value: members(third) }),
      atUsersStay(),
      dropUser(third[5] ?? ""),
    );
    // A PUT of 1000 members that replaces the 1000 members of the group (MI-3).
    counts.put = await late(
      "PUT",
      `/Groups/${id}`,
      body(second),
      atUsersStay(),
      dropUser(second[5] ?? ""),
    );
    // The role recompute: a role that changed after the read makes the last role update
    // write fewer rows. The rename out of the map and the delete change each role.
    const roleOf = (scimUserId: string) => async () => {
      const user = await userOf(scimUserId);
      await env.DB.prepare("UPDATE ta_member SET role = 'web' WHERE user_id = ?").bind(user).run();
      return () =>
        env.DB.prepare("UPDATE ta_member SET role = 'admin' WHERE user_id = ?").bind(user).run();
    };
    const atRoleUpdate = (sql: string) => sql.startsWith("UPDATE ta_member SET role");
    counts.rename = await late(
      "PATCH",
      `/Groups/${id}`,
      patch({ op: "replace", path: "displayName", value: "Former" }),
      atRoleUpdate,
      roleOf(first[7] ?? ""),
    );
    counts.delete = await late(
      "DELETE",
      `/Groups/${id}`,
      undefined,
      atRoleUpdate,
      roleOf(first[7] ?? ""),
    );
    // More role pairs: each adds two queries to the write and one to its undo. The meter
    // keeps room for the undo of a late conflict, and counts the audit row too. So a write
    // whose undo would not fit is refused, and the undo of the refusal restores the group row
    // and the team row (ruling 85 of plan 12d).
    for (const name of ["r1", "r2"]) {
      const role = await setup.api.createRole({
        user: owner,
        organizationId,
        name,
        permissions: { member: ["read"] },
      });
      if (!role.ok) throw new Error(role.code);
    }
    const roleMix = async (list: readonly string[], role: string) => {
      const users = await Promise.all(list.map(userOf));
      await env.DB.prepare(
        "UPDATE ta_member SET role = ?1 WHERE user_id IN (SELECT value FROM json_each(?2))",
      )
        .bind(role, JSON.stringify(users))
        .run();
    };
    /** A mixed PATCH that the meter must refuse with no write: its queries. */
    const refusedLate = async () => {
      const before = await state();
      await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
      const { db: view, c } = counting(env.DB);
      const trap = trapped(view, atUsersStay(), async () => {
        throw new Error("the meter must stop the write first");
      });
      const res = await make(trap.db, true).handle(
        new Request(`${API}/auth/scim/v2/Groups/${id}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
          body: JSON.stringify(
            patch(
              { op: "add", path: "members", value: members(third.slice(0, PATCH_CAP - 1)) },
              { op: "remove", path: `members[value eq "${first[0]}"]` },
            ),
          ),
        }),
      );
      const refused = JSON.parse(await res.text()) as Record<string, unknown>;
      expect([res.status, refused.detail]).toEqual([
        400,
        "the role change of this request does not fit one request; change fewer members in each request",
      ]);
      expect(trap.fired()).toBe(false);
      expect(await state()).toEqual(before);
      return c.n;
    };
    // Three pairs: the added persons hold two roles, and the removed one leaves admin.
    await roleMix(third.slice(0, 300), "web");
    counts.threePairs = await refusedLate();
    // Four pairs: the added persons hold three roles.
    await roleMix(third.slice(300, 600), "r1");
    counts.fourPairs = await refusedLate();
    await roleMix(third.slice(0, 600), "member");
    // The PUT of the swap passes, inside 50 queries too.
    const swap = await call(token, "PUT", `/Groups/${id}`, body(second), true);
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    expect(await count("SELECT count(*) AS n FROM ta_team_member")).toBe(PATCH_CAP);
    expect(await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'")).toBe(PATCH_CAP);
    counts.swap = swap.queries;
    console.log(`late conflicts: ${JSON.stringify(counts)}`);
    expect(counts).toEqual(MEASURED_LATE);
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(50);
  }, 600_000);
});

/**
 * The late conflicts on the binding, 2026-10-24, for ruling 85 of plan 12d,
 * with the token write of `lastUsedAt` in each call. Before the ruling the
 * `mixed` scene of the review (MA-1) sent 54 queries: 40 of the write and
 * 14 of the undo. Since the ruling the undo of the insert chunks of one
 * model is one delete. A read of up to 2000 ids is one statement, and 1000
 * rows take three inserts. `put` is the PUT of 1000 members over 1000
 * others (MI-3). Each person who leaves the team has a session in it. The
 * role pairs: the meter keeps room for the undo and counts the audit row
 * too, so it refuses those writes after the group row and the team row.
 * Their undo restores both. With no such room the same writes sent 50 and
 * 53 queries at their late conflicts.
 *
 * Ruling 86: the session ends of the persons who leave the team come after
 * the audit row, so no late conflict restores them. `mixed` sends 44 and
 * `put` 46 on 2026-10-24. The role pairs stay refused: a fault at the
 * session end, the last write, sends 51 and 54 with the undo of the audit
 * row. Their late conflicts at the read of usersStay send 47 and 50.
 */
const MEASURED_LATE = {
  create: 35,
  mixed: 44,
  mixedScimUser: 28,
  adds: 37,
  put: 46,
  rename: 23,
  delete: 25,
  threePairs: 20,
  fourPairs: 20,
  swap: 39,
};

/**
 * A view of `db` that counts each statement and fails statement `target`
 * (from 1) once, alone or in a batch: a fault of D1 at that statement. A
 * failed batch counts each of its statements, as D1 does. `fired` names the
 * statement that failed, or is empty when no statement failed.
 */
function faulty(db: D1Database, target: number) {
  const c = { n: 0, fired: "" };
  const sqlOf = new WeakMap<object, string>();
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v), sql);
        const x = Reflect.get(a, b);
        if (b === "run" || b === "all" || b === "first" || b === "raw")
          return (...args: unknown[]) => {
            c.n++;
            if (c.n === target) {
              c.fired = sql;
              return Promise.reject(new Error("D1 fault"));
            }
            return (x as (...y: unknown[]) => unknown).apply(a, args);
          };
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
    sqlOf.set(p, sql);
    return p;
  };
  const view = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          const from = c.n;
          c.n += st.length;
          if (from < target && target <= c.n) {
            c.fired = sqlOf.get(st[target - from - 1] as object) ?? "batch";
            return Promise.reject(new Error("D1 fault"));
          }
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: view as D1Database, c };
}

describe("the session ends of the persons who leave a team on D1 (ruling 86 of plan 12d)", () => {
  it("keeps a PUT of 1000 over 1000 inside 50 queries at a fault of each statement, for 1, 3, 4, and 50 sessions of each leaver", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const ids = await users(token, 2 * PATCH_CAP);
    const first = ids.slice(0, PATCH_CAP);
    const second = ids.slice(PATCH_CAP);
    const body = (list: readonly string[]) => ({
      schemas: [GROUP_URN],
      displayName: "Admins",
      members: members(list),
    });
    const made = await call(token, "POST", "/Groups", body(first));
    expect(made.status).toBe(201);
    const id = String(made.body.id);
    const teamId = String(
      await env.DB.prepare("SELECT team_id AS n FROM ta_scim_group WHERE id = ?")
        .bind(id)
        .first("n"),
    );
    const cols = (
      await env.DB.prepare("SELECT name FROM pragma_table_info('ta_session')").all()
    ).results.map((r) => String(r.name));
    // The rows copy the session of the owner, as a sign-in writes them.
    const pick = (c: string) =>
      c === "id"
        ? "'s-' || u.id || '-' || j.i"
        : c === "user_id"
          ? "u.user_id"
          : c === "token_hash"
            ? "'t-' || u.id || '-' || j.i"
            : c === "active_organization_id"
              ? "u.organization_id"
              : c === "active_team_id"
                ? "?2"
                : `s.${c}`;
    /** `k` sessions of each member of `first`, each one acting in the team. */
    const sessions = async (k: number) => {
      await env.DB.prepare("DELETE FROM ta_session WHERE id LIKE 's-%'").run();
      await env.DB.prepare(
        `WITH RECURSIVE j(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM j WHERE i < ?3) INSERT INTO ta_session (${cols.join(", ")}) SELECT ${cols.map(pick).join(", ")} FROM ta_session s, ta_scim_user u, j WHERE s.id = (SELECT min(id) FROM ta_session) AND u.id IN (SELECT value FROM json_each(?1))`,
      )
        .bind(JSON.stringify(first), teamId, k)
        .run();
    };
    const state = async () => ({
      groups: await count("SELECT count(*) AS n FROM ta_scim_group"),
      rows: await count("SELECT count(*) AS n FROM ta_scim_group_member"),
      teams: await count("SELECT count(*) AS n FROM ta_team"),
      teamRows: await count("SELECT count(*) AS n FROM ta_team_member"),
      versions: await count("SELECT coalesce(sum(version), 0) AS n FROM ta_scim_group"),
      admins: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'admin'"),
      members: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'member'"),
      sessions: await count("SELECT count(*) AS n FROM ta_session"),
      inTeam: await count("SELECT count(*) AS n FROM ta_session WHERE active_team_id IS NOT NULL"),
      audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
      users: await count("SELECT count(*) AS n FROM ta_user"),
    });
    /** The PUT of `second` over `first` with a fault at statement `target`. */
    const put = async (target: number) => {
      await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
      const { db: view, c } = faulty(env.DB, target);
      const res = await make(view, true).handle(
        new Request(`${API}/auth/scim/v2/Groups/${id}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
          body: JSON.stringify(body(second)),
        }),
      );
      await res.text();
      return { status: res.status, queries: c.n, fired: c.fired };
    };
    const worst: Record<string, number> = {};
    for (const k of [1, 3, 4, 50]) {
      await sessions(k);
      const before = await state();
      expect(before.inTeam).toBe(k * PATCH_CAP);
      // A fault at each statement, the session end too, until the PUT runs with no fault.
      // A fault at a read costs what a conflict at that read costs: the write up to it and
      // the undo. Each faulted run must leave the state as it was.
      let most = 0;
      let clean = 0;
      for (let target = 1; clean === 0; target++) {
        const r = await put(target);
        if (r.fired === "") {
          expect(r.status).toBe(200);
          clean = r.queries;
          break;
        }
        expect([target, r.status], r.fired).toEqual([target, 500]);
        expect(await state(), `${k} sessions, fault at ${target}: ${r.fired}`).toEqual(before);
        most = Math.max(most, r.queries);
      }
      // The PUT ended the session of each leaver in the team.
      expect(await state()).toEqual({
        ...before,
        versions: before.versions + 1,
        inTeam: 0,
        audit: before.audit + 1,
      });
      worst[`fault${k}`] = most;
      worst[`clean${k}`] = clean;
      // Back to the members of `first`, for the next count of sessions.
      expect((await call(token, "PUT", `/Groups/${id}`, body(first))).status).toBe(200);
    }
    console.log(`session ends: ${JSON.stringify(worst)}`);
    // Measured on the binding, 2026-10-24.
    expect(worst).toEqual({
      fault1: 50,
      clean1: 39,
      fault3: 50,
      clean3: 39,
      fault4: 50,
      clean4: 39,
      fault50: 50,
      clean50: 39,
    });
    for (const n of Object.values(worst)) expect(n).toBeLessThanOrEqual(50);
  }, 600_000);
});

/**
 * The state that a faulted SCIM request must leave as it was: the rows of
 * each model that a group write touches, the roles, and the sessions.
 */
const faultState = async () => ({
  groups: await count("SELECT count(*) AS n FROM ta_scim_group"),
  rows: await count("SELECT count(*) AS n FROM ta_scim_group_member"),
  teams: await count("SELECT count(*) AS n FROM ta_team"),
  teamRows: await count("SELECT count(*) AS n FROM ta_team_member"),
  versions: await count("SELECT coalesce(sum(version), 0) AS n FROM ta_scim_group"),
  roles: String(
    await env.DB.prepare(
      "SELECT group_concat(role || ':' || n) AS n FROM (SELECT role, count(*) AS n FROM ta_member GROUP BY role ORDER BY role)",
    ).first("n"),
  ),
  sessions: await count("SELECT count(*) AS n FROM ta_session"),
  inTeam: await count("SELECT count(*) AS n FROM ta_session WHERE active_team_id IS NOT NULL"),
  audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
  users: await count("SELECT count(*) AS n FROM ta_user"),
});

/**
 * One SCIM request with a fault at statement 1, then 2, and on, until a run
 * ends with no fault. Each faulted run must answer 500 and leave
 * `faultState` as it was. The answer: the worst count of a faulted run, and
 * the status and the count of the clean run.
 */
async function sweep(token: string, method: string, path: string, body?: unknown) {
  const before = await faultState();
  let worst = 0;
  for (let target = 1; ; target++) {
    await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
    const { db: view, c } = faulty(env.DB, target);
    const res = await make(view, true).handle(
      new Request(`${API}/auth/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    await res.text();
    if (c.fired === "") return { worst, status: res.status, clean: c.n };
    expect([target, res.status], c.fired).toEqual([target, 500]);
    expect(await faultState(), `${method} ${path}, fault at ${target}: ${c.fired}`).toEqual(before);
    worst = Math.max(worst, c.n);
  }
}

/** A session of each SCIM User of `scimUserIds` acting in `teamId`, `k` times. */
async function teamSessions(scimUserIds: readonly string[], teamId: string, k: number) {
  const cols = (
    await env.DB.prepare("SELECT name FROM pragma_table_info('ta_session')").all()
  ).results.map((r) => String(r.name));
  // The rows copy the session of the owner, as a sign-in writes them.
  const pick = (c: string) =>
    c === "id"
      ? "'s-' || u.id || '-' || j.i"
      : c === "user_id"
        ? "u.user_id"
        : c === "token_hash"
          ? "'t-' || u.id || '-' || j.i"
          : c === "active_organization_id"
            ? "u.organization_id"
            : c === "active_team_id"
              ? "?2"
              : `s.${c}`;
  await env.DB.prepare("DELETE FROM ta_session WHERE id LIKE 's-%'").run();
  await env.DB.prepare(
    `WITH RECURSIVE j(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM j WHERE i < ?3) INSERT INTO ta_session (${cols.join(", ")}) SELECT ${cols.map(pick).join(", ")} FROM ta_session s, ta_scim_user u, j WHERE s.id = (SELECT min(id) FROM ta_session) AND u.id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(scimUserIds), teamId, k)
    .run();
}

describe("the faults of a group delete and of the role pair pushes on D1 (ruling 87 of plan 12d)", () => {
  it("keeps a DELETE of a group of 1000 members inside 50 queries at a fault of each statement, for 1, 3, and 50 sessions of each member", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const first = await users(token, PATCH_CAP);
    const worst: Record<string, number> = {};
    for (const k of [1, 3, 50]) {
      const made = await call(token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Admins",
        members: members(first),
      });
      expect(made.status).toBe(201);
      const id = String(made.body.id);
      const teamId = String(
        await env.DB.prepare("SELECT team_id AS n FROM ta_scim_group WHERE id = ?")
          .bind(id)
          .first("n"),
      );
      await teamSessions(first, teamId, k);
      const before = await faultState();
      expect([before.inTeam, before.roles]).toEqual([k * PATCH_CAP, "admin:1000,owner:1"]);
      const r = await sweep(token, "DELETE", `/Groups/${id}`);
      expect(r.status).toBe(204);
      // The delete ended each session in the team, and took the group, the team, and the roles.
      expect(await faultState()).toEqual({
        ...before,
        groups: before.groups - 1,
        rows: before.rows - PATCH_CAP,
        teams: before.teams - 1,
        teamRows: before.teamRows - PATCH_CAP,
        versions: before.versions - 1,
        roles: "member:1000,owner:1",
        inTeam: 0,
        audit: before.audit + 1,
      });
      worst[`fault${k}`] = r.worst;
      worst[`clean${k}`] = r.clean;
    }
    console.log(`group deletes: ${JSON.stringify(worst)}`);
    // Measured on the binding, 2026-10-24. Before ruling 87 the delete ended the sessions
    // before its audit row, and a fault there sent 32, 34, and 68.
    expect(worst).toEqual({
      fault1: 32,
      clean1: 24,
      fault3: 32,
      clean3: 24,
      fault50: 32,
      clean50: 24,
    });
    for (const n of Object.values(worst)) expect(n).toBeLessThanOrEqual(50);
  }, 600_000);

  it("answers 204 to the smaller steps of the docs, 500 adds with 3 role pairs and 333 adds with 4, inside 50 queries at a fault of each statement", async () => {
    const setup = make(env.DB, false);
    const { organizationId, owner, token } = await acme(setup);
    const ids = await users(token, 2 * PATCH_CAP);
    const first = ids.slice(0, PATCH_CAP);
    const second = ids.slice(PATCH_CAP);
    const made = await call(token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName: "Admins",
      members: members(first),
    });
    expect(made.status).toBe(201);
    const id = String(made.body.id);
    const teamId = String(
      await env.DB.prepare("SELECT team_id AS n FROM ta_scim_group WHERE id = ?")
        .bind(id)
        .first("n"),
    );
    await teamSessions(first, teamId, 1);
    const role = await setup.api.createRole({
      user: owner,
      organizationId,
      name: "r1",
      permissions: { member: ["read"] },
    });
    if (!role.ok) throw new Error(role.code);
    const roleMix = async (list: readonly string[], name: string) =>
      env.DB.prepare(
        "UPDATE ta_member SET role = ?1 WHERE user_id IN (SELECT user_id FROM ta_scim_user WHERE id IN (SELECT value FROM json_each(?2)))",
      )
        .bind(name, JSON.stringify(list))
        .run();
    const mixed = (adds: readonly string[], gone: string) =>
      patch(
        { op: "add", path: "members", value: members(adds) },
        { op: "remove", path: `members[value eq "${gone}"]` },
      );
    const counts: Record<string, number> = {};
    // Three pairs: web to admin, member to admin, and admin to member.
    const three = second.slice(0, 500);
    await roleMix(three.slice(0, 150), "web");
    let before = await faultState();
    const r3 = await sweep(token, "PATCH", `/Groups/${id}`, mixed(three, first[0] ?? ""));
    expect(r3.status).toBe(204);
    expect(await faultState()).toEqual({
      ...before,
      rows: before.rows + 499,
      teamRows: before.teamRows + 499,
      versions: before.versions + 1,
      roles: "admin:1499,member:501,owner:1",
      inTeam: before.inTeam - 1,
      audit: before.audit + 1,
    });
    counts.threePairs = r3.worst;
    counts.threePairsClean = r3.clean;
    // Four pairs: web, r1, and member to admin, and admin to member.
    const four = second.slice(500, 833);
    await roleMix(four.slice(0, 100), "web");
    await roleMix(four.slice(100, 200), "r1");
    before = await faultState();
    const r4 = await sweep(token, "PATCH", `/Groups/${id}`, mixed(four, first[1] ?? ""));
    expect(r4.status).toBe(204);
    expect(await faultState()).toEqual({
      ...before,
      rows: before.rows + 332,
      teamRows: before.teamRows + 332,
      versions: before.versions + 1,
      roles: "admin:1831,member:169,owner:1",
      inTeam: before.inTeam - 1,
      audit: before.audit + 1,
    });
    counts.fourPairs = r4.worst;
    counts.fourPairsClean = r4.clean;
    console.log(`role pair steps: ${JSON.stringify(counts)}`);
    // Measured on the binding, 2026-10-24: the numbers of scim.mdx and routes.md.
    expect(counts).toEqual({
      threePairs: 49,
      threePairsClean: 39,
      fourPairs: 50,
      fourPairsClean: 39,
    });
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(50);
  }, 600_000);
});
