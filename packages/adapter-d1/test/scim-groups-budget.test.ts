import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

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

const API = "https://api.example.com";
const APP = { kind: "app", name: "budget" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** PATCH_MEMBERS_MAX and GROUP_ROLE_USERS_MAX of groups.ts, typed here. */
const PATCH_CAP = 9;
const ROLE_CAP = 250;

/** A view of `db` that counts each statement, and each statement of a batch. */
function counting(db: D1Database) {
  const c = { n: 0 };
  const hit = (b: PropertyKey) => b === "run" || b === "all" || b === "first" || b === "raw";
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v));
        if (hit(b)) c.n++;
        const x = Reflect.get(a, b);
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          c.n += st.length;
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: counted as D1Database, c };
}

const sent: MailMessage[] = [];
const txt: Record<string, string[]> = {};
const roleHooks: string[] = [];

/** The engine on `db`. `limited` serves it with the D1 limiter, as worker-d1 does. */
function make(db: D1Database, limited: boolean, extra: Partial<AuthConfig> = {}) {
  return createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: limited ? createD1Limiter(db) : { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {
      teams: {},
      dynamicRoles: { maxPerOrganization: 5 },
      limits: { membersPerTeam: 1000 },
    },
    sso: {
      oidc: true,
      dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }],
      fetch: async () => Response.json({}),
    },
    scim: { groups: "both" },
    // The role hooks make the recompute read the users of each role change.
    hooks: {
      organization: {
        beforeUpdateMemberRole: (e) => void roleHooks.push(e.role),
        afterUpdateMemberRole: () => {},
      },
    },
    ...extra,
  });
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  sent.length = 0;
  roleHooks.length = 0;
});

/** A magic link sign-in of `email` on `auth`: the user. */
async function signIn(auth: ReturnType<typeof make>, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.user;
}

/**
 * The organization `acme`: its verified domain, an OIDC connection, the
 * dynamic role `web`, the role map, and a SCIM token.
 */
async function acme(auth: ReturnType<typeof make>) {
  const owner = await signIn(auth, "owner@acme.example");
  const made = await auth.api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const sso = auth.api.sso;
  const scim = auth.api.scim;
  if (!sso || !scim) throw new Error("no sso or scim api");
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  if (!(await sso.domains.verify({ actor: APP, id: domain.value.id })).ok)
    throw new Error("no proof");
  const connection = await sso.connections.create({
    actor: APP,
    organizationId,
    kind: "oidc",
    label: "Acme IdP",
    issuer: "https://login.acme-idp.example",
    clientId: "acme-client",
    clientSecret: "acme-secret-0123456789",
    endpoints: {
      authorizeUrl: "https://login.acme-idp.example/authorize",
      tokenUrl: "https://login.acme-idp.example/token",
      jwksUrl: "https://login.acme-idp.example/keys",
    },
  });
  if (!connection.ok) throw new Error(connection.code);
  const role = await auth.api.createRole({
    user: owner,
    organizationId,
    name: "web",
    permissions: { member: ["read"] },
  });
  if (!role.ok) throw new Error(role.code);
  const map = await scim.setRoleMap({
    actor: APP,
    organizationId,
    map: { Admins: "admin", Web: "web" },
  });
  if (!map.ok) throw new Error(map.code);
  const token = await scim.tokens.create({ actor: APP, organizationId, name: "directory" });
  if (!token.ok) throw new Error(token.code);
  return { organizationId, token: token.value.token };
}

/**
 * One SCIM request: its status, body, and queries. With `worst`, the token
 * was last used two minutes before, as after a pause of the directory. Then
 * the route also writes `lastUsedAt`, the worst case of its steps.
 */
async function call(token: string, method: string, path: string, body?: unknown, worst = false) {
  if (worst)
    await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
  const { db: view, c } = counting(env.DB);
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
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
    queries: c.n,
  };
}

/** `n` SCIM Users of acme: their ids. */
async function users(token: string, n: number, from = 0) {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    const r = await call(token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: `u${i}@acme.example`,
    });
    if (r.status !== 201) throw new Error(`user ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    ids.push(String(r.body.id));
  }
  return ids;
}

const members = (ids: readonly string[]) => ids.map((value) => ({ value }));
const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });
const count = async (sql: string) => Number(await env.DB.prepare(sql).first("n"));

describe("the SCIM Groups on D1 (plan 12d Task 11, ruling 25 N4)", () => {
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
  }, 120_000);

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
    const { token } = await acme(setup);
    const ids = await users(token, 9);
    const gone = ids[0] ?? "";
    const web = ids.slice(1, 5);
    const plain = ids.slice(5, 9);
    const made: string[] = [];
    for (const [name, list] of [
      ["Admins", [gone]],
      ["Web", web],
    ] as const) {
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
      web: await count("SELECT count(*) AS n FROM ta_member WHERE role = 'web'"),
      audit: await count("SELECT count(*) AS n FROM ta_operator_audit"),
    });
    const before = await state();
    // Three role changes in one write: member to admin, web to admin, and admin to member.
    // Their updates and the team writes do not fit the budget, so the write stops.
    const refused = await call(
      token,
      "PATCH",
      `/Groups/${admins}`,
      patch(
        { op: "add", path: "members", value: members([...web, ...plain]) },
        { op: "remove", path: `members[value eq "${gone}"]` },
      ),
      true,
    );
    expect([refused.status, refused.body.scimType]).toEqual([400, "invalidValue"]);
    expect(refused.body.detail).toBe(
      "the role change of this request does not fit one request; change fewer members in each request",
    );
    expect(await state()).toEqual(before);
    expect({ refused: refused.queries }).toEqual(MEASURED_TOO_LARGE);
    expect(refused.queries).toBeLessThanOrEqual(50);
  }, 120_000);

  it("ends a list page with members at 10000 member rows, inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { organizationId, token } = await acme(setup);
    const groups: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const r = await call(token, "POST", "/Groups", { schemas: [GROUP_URN], displayName: name });
      expect(r.status).toBe(201);
      groups.push(String(r.body.id));
    }
    const [alpha, beta, gamma] = groups;
    // 5001 Users in Alpha and in Beta, and one of them in Gamma: 10003 member rows. SQL
    // writes the rows that 556 PATCH requests of 9 members each would write.
    const now = Date.now();
    const n = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)";
    const su = "'su-' || printf('%05d', i)";
    await env.DB.batch([
      env.DB.prepare(
        `${n} INSERT INTO ta_user (id, created_at, updated_at, email, email_verified) SELECT 'mu-' || i, ?1, ?1, 'm' || i || '@acme.example', 1 FROM n`,
      ).bind(now),
      env.DB.prepare(
        `${n} INSERT INTO ta_member (id, created_at, updated_at, organization_id, user_id, role) SELECT 'mb-' || i, ?1, ?1, ?2, 'mu-' || i, 'member' FROM n`,
      ).bind(now, organizationId),
      env.DB.prepare(
        `${n} INSERT INTO ta_scim_user (id, created_at, updated_at, organization_id, user_id, user_name, user_name_key, active, data, version) SELECT ${su}, ?1, ?1, ?2, 'mu-' || i, 'm' || i || '@acme.example', 'm' || i || '@acme.example', 1, '{}', 1 FROM n`,
      ).bind(now, organizationId),
      ...[alpha, beta].map((g) =>
        env.DB.prepare(
          `${n} INSERT INTO ta_scim_group_member (id, created_at, updated_at, group_id, scim_user_id) SELECT 'gm-' || ?2 || '-' || i, ?1, ?1, ?2, ${su} FROM n`,
        ).bind(now, g ?? ""),
      ),
      env.DB.prepare(
        "INSERT INTO ta_scim_group_member (id, created_at, updated_at, group_id, scim_user_id) VALUES ('gm-gamma', ?1, ?1, ?2, 'su-00000')",
      ).bind(now, gamma ?? ""),
    ]);
    expect(await count("SELECT count(*) AS n FROM ta_scim_group_member")).toBe(10003);
    const page = async (start: number) => {
      const r = await call(token, "GET", `/Groups?startIndex=${start}&count=100`, undefined, true);
      const list = r.body.Resources as { id: string; members?: unknown[] }[];
      return {
        total: r.body.totalResults,
        groups: list.map((g) => [g.id, g.members?.length ?? 0]),
        items: Number(r.body.itemsPerPage),
        queries: r.queries,
      };
    };
    // By id, each page holds whole groups, at most 10000 member rows.
    const order = [...groups].sort().map((id) => [id, id === gamma ? 1 : 5001] as const);
    const fits = (from: number) => {
      const out: (readonly [string, number])[] = [];
      let rows = 0;
      for (const g of order.slice(from)) {
        if (out.length > 0 && rows + g[1] > 10000) break;
        out.push(g);
        rows += g[1];
      }
      return out;
    };
    const first = await page(1);
    expect(first).toMatchObject({ total: 3, groups: fits(0), items: fits(0).length });
    expect(first.items).toBeLessThan(3);
    const next = await page(first.items + 1);
    expect(next).toMatchObject({ total: 3, groups: fits(first.items) });
    const counts = { first: first.queries, next: next.queries };
    expect(counts).toEqual(MEASURED_LIST);
    for (const q of Object.values(counts)) expect(q).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * The counts of the run on the binding, 2026-10-22, with the token write of
 * `lastUsedAt` in each call (the worst route step). `mixed` is the worst
 * write at PATCH_MEMBERS_MAX: 8 adds and 1 removal of a mapped group with a
 * team, so two role changes, a team member removal, and the team member
 * adds. The tenth value (`over`) answers 400 after 6 queries, before any
 * write. `back` is the worst write at GROUP_ROLE_USERS_MAX: a rename into
 * the map gives each of 250 members the mapped role.
 */
const MEASURED_CAP = {
  create: 42,
  over: 6,
  mixed: 49,
  adds: 45,
  get: 6,
  list: 5,
  check: 6,
};
const MEASURED_ROLES = { rename: 41, back: 46, delete: 44 };
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
 * 51 queries.
 */
const MEASURED_TOO_LARGE = { refused: 20 };
/** Two list pages with members, each of whole groups, at most 10000 member rows. */
const MEASURED_LIST = { first: 6, next: 6 };

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

  it("refuses the account delete of the sole member of an organization with a group inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { token } = await acme(setup);
    const [ada] = await users(token, 1);
    for (let i = 0; i < 1; i++) {
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
    expect(done).toMatchObject({ ok: false, code: "delete_too_large" });
    for (const table of ["ta_organization", "ta_scim_group", "ta_scim_group_member"])
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(1);
    expect(await count("SELECT count(*) AS n FROM ta_user")).toBe(2);
    expect({ accountDelete: c.n }).toEqual(MEASURED_ACCOUNT_DELETE);
    expect(c.n).toBeLessThanOrEqual(50);
  }, 300_000);
});

/**
 * The organization delete with 100 SCIM Groups (ruling 74 of plan 12d).
 * The group read, the scimGroupMember delete, and the scimGroup delete add
 * 3 queries to the delete. The count does not grow with the groups: one
 * delete binds the 100 ids.
 */
const MEASURED_ORGANIZATION_DELETE = { delete: 32 };
/**
 * The refusal of an account delete whose solo organization has a SCIM
 * Group (ruling 74 of plan 12d). The group read comes after the first
 * deletes, so the undo of the transaction counts too.
 */
const MEASURED_ACCOUNT_DELETE = { accountDelete: 14 };
const GROUPS = 500;
