import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The account delete of an operator and a removal of the platform member
// row on real D1 (ruling 63 of plan 12f). Each ends the impersonation
// sessions that the operator opened. D1 Free allows 50 queries per
// invocation (D1 limits page updated 21 April 2026, read 2026-10-21). This
// test counts each statement that reaches the D1 binding through
// `auth.handle`, and the D1 limiter on the same view. So the route, the act,
// and the steps after the commit all count. Each sweep is one invocation
// too, and counts the same way.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const SECRET = "operator-support-0123456789abcdef-0123";

/** The key that gives the statement of the binding under a counting view. */
const RAW = Symbol("raw");

/** A view of `db` that counts each statement it runs, and each statement of a batch. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            count.queries++;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          count.queries += statements.length;
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, count };
}

let current = new Date("2026-10-21T00:00:00.000Z");
const clock = { now: () => current };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The session ends that the hook saw, across all invocations of one test. */
const endings: { id: string; reason: string }[] = [];

/**
 * The engine on `db`, with a `session.afterEnd` hook, the user tools, one
 * operator secret, and a slide of 6 hours. Each call makes a new adapter:
 * one invocation.
 */
async function engine(
  db: D1Database,
  sent: MailMessage[],
  limiter?: AuthConfig["limiter"],
  extra: Partial<AuthConfig> = {},
) {
  const storage = createD1Adapter(db);
  const input: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    clock,
    limiter: limiter ?? { allow: async () => true },
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { slidingRefreshDays: 0.25 },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: {
      secrets: [
        { name: "support", secretHash: await sha256Hex(SECRET), scopes: ["users", "sessions"] },
      ],
      users: true,
    },
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          endings.push({ id: session.id, reason });
        },
      },
    },
    ...extra,
  };
  return { auth: createAuth(input), storage };
}

type Auth = Awaited<ReturnType<typeof engine>>["auth"];

/** `count` sign-ins of one address by a magic link: the user id, the token of the last session, and each token. */
async function signIns(auth: Auth, sent: MailMessage[], email: string, count: number) {
  let userId = "";
  let last = "";
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    userId = s.user.id;
    last = r.value.token;
    tokens.push(last);
  }
  return { userId, token: last, tokens };
}

/**
 * A platform operator through the flows: `createAdmin`, a magic link
 * sign-in, the first password, and the email method of the second factor.
 * `granted` runs after `createAdmin` and before the sign-in. Answers the
 * token of a fresh session.
 */
async function platformOperator(
  auth: Auth,
  sent: MailMessage[],
  email = "op@example.com",
  granted?: () => Promise<void>,
) {
  const made = await auth.api.operator.createAdmin({
    actor: APP,
    email,
    reason: "First operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  await granted?.();
  const { token } = await signIns(auth, sent, email, 1);
  const session = await auth.api.getSession(token);
  if (!session) throw new Error("no session");
  const changed = await auth.api.password?.change({
    session,
    newPassword: "correct horse battery",
  });
  if (!changed?.ok) throw new Error("no password");
  const res = await auth.handle(
    new Request(`${BASE}/auth/second-factor/email/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-tempo_session=${token}` },
      body: JSON.stringify({ password: "correct horse battery" }),
    }),
  );
  if (res.status !== 200) throw new Error(`enable answered ${res.status}`);
  return token;
}

/** The token of the first of `tokens` whose session row still exists. */
async function leftToken(tokens: string[]): Promise<string> {
  for (const token of tokens) {
    const row = await env.DB.prepare("SELECT id FROM ta_session WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first();
    if (row) return token;
  }
  throw new Error("no left session");
}

/** One route call as one invocation on a counting view: the status, the body, and the queries. */
async function invoke(
  sent: MailMessage[],
  path: string,
  headers: Record<string, string>,
  body: unknown,
  extra: Partial<AuthConfig> = {},
) {
  const { db, count } = counting(env.DB);
  const { auth } = await engine(db, sent, createD1Limiter(db, clock), extra);
  const res = await auth.handle(
    new Request(`${BASE}/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    queries: count.queries,
  };
}

/** Sweeps, one invocation each, until no pending-end row stays: the queries of each sweep. */
async function sweepAll(sent: MailMessage[], extra: Partial<AuthConfig> = {}) {
  const queries: number[] = [];
  for (;;) {
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_verification WHERE purpose = 'session-end'",
    ).first<{ n: number }>();
    if (!left?.n) return queries;
    if (queries.length >= 20) throw new Error("the sweep makes no progress");
    const { db, count } = counting(env.DB);
    const { auth } = await engine(db, sent, createD1Limiter(db, clock), extra);
    await auth.api.sweepExpired();
    queries.push(count.queries);
  }
}

/**
 * The counts of the run on the binding at the plan 12k rebase, 2026-10-21:
 * the queries of the act, the sessions it ended, and the queries of each
 * sweep. The account delete makes many deletes of its own, so its page ends
 * the own session and 2 impersonation sessions. The removal ends 11. Plan
 * 12k adds writes to both acts (the team rows and the tokens), and one
 * delete to each sweep. So each page ends fewer: the first run of 12f gave
 * [49, 4, [48, 48, 37]] and [50, 13, [48, 45]]. Plan 12d Task 1 adds
 * scimUser to the user child models, so the account delete sends one more
 * delete: 48 became 49 on 2026-10-21. Plan 12d ruling 28 adds 3 deletes to
 * each organization that goes, the domain, connection, and SCIM token rows.
 * This scene deletes no organization, so the run of 2026-10-21 still gives
 * 49. A probe on the binding the same day: the account delete of a user
 * with one solo organization sent 41 queries before the change and 44 after.
 * Plan 12d ruling 30 reads the memberships once before any write, so the
 * act reserves one more call and its page ends one session fewer: the run
 * of 2026-10-21 gives 48 queries, 2 sessions, and sweeps of 47, 47, and 46.
 */
const DELETE_COUNTS: [number, number, number[]] = [48, 2, [47, 47, 46]];
const REMOVE_COUNTS: [number, number, number[]] = [49, 11, [47, 47, 26]];

const asUser = (token: string) => ({ cookie: `__Host-tempo_session=${token}`, origin: BASE });

/** The headers of a call with the operator secret. */
const asSecret = { authorization: `Operator ${SECRET}` };

/** The impersonation tool on, with the longest life, so 40 starts at the start limit all live. */
const on = async () =>
  ({
    operator: {
      secrets: [
        { name: "support", secretHash: await sha256Hex(SECRET), scopes: ["users", "sessions"] },
      ],
      users: true,
      impersonation: { ttlMinutes: 240 },
    },
  }) satisfies Partial<AuthConfig>;

/**
 * Two platform operators, and 40 impersonation sessions that the second
 * one opened, 4 on each of 10 users. The starts come 3 minutes apart: 20
 * an hour, the start limit (`IMPERSONATE_PER_USER`), and all inside the
 * life of 240 minutes. With `auditors`, each operator gets the role
 * `operator,auditor` before the impersonations (`auditorPart`). A write of
 * an operator's member row ends the impersonations, so it comes first.
 */
async function fortyImpersonations(
  sent: MailMessage[],
  extra: Partial<AuthConfig>,
  auditors = false,
) {
  const { auth: setup } = await engine(env.DB, sent, undefined, extra);
  const first = await platformOperator(setup, sent);
  const bobToken = await platformOperator(
    setup,
    sent,
    "bob@example.com",
    auditors ? () => auditorPart(setup, first, "bob@example.com") : undefined,
  );
  if (auditors) await auditorPart(setup, bobToken, "op@example.com");
  const targets: string[] = [];
  for (let i = 0; i < 10; i++)
    targets.push((await signIns(setup, sent, `user${i}@example.com`, 1)).userId);
  const tokens: string[] = [];
  for (let i = 0; i < 40; i++) {
    current = new Date(current.getTime() + 3 * 60_000);
    const bob = await setup.api.getSession(bobToken);
    if (!bob) throw new Error("the session ended");
    const r = await setup.api.operator.impersonate({
      operator: bob,
      userId: targets[i % 10] ?? "",
      reason: `Ticket ${i}`,
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    tokens.push(r.value.token);
  }
  const bob = await setup.api.getSession(bobToken);
  if (!bob) throw new Error("the session ended");
  endings.length = 0;
  return { setup, first, bobToken, bobId: bob.user.id, tokens };
}

async function impersonations(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM ta_session WHERE actor_id IS NOT NULL",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The cause of each stop row, in id order. */
async function stopCauses(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT data FROM ta_operator_audit WHERE action = 'impersonation_stop' ORDER BY id",
  ).all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data).cause);
}

/** The impersonation tool on, and dynamic roles on (plan 12k). */
const withDynamicRoles = async () =>
  ({
    ...(await on()),
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      dynamicRoles: { maxPerOrganization: 10 },
    },
  }) satisfies Partial<AuthConfig>;

/**
 * Gives the user of `email` the role `operator,auditor` through
 * `updateMemberRole`, as the user of `byToken`. The first call makes the
 * dynamic role `auditor` of the platform organization. So each standing and
 * each target role of a member write reads the role rows (ruling 48 of plan
 * 12k).
 */
async function auditorPart(setup: Auth, byToken: string, email: string) {
  const platform = await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
    .bind("platform-co")
    .first<{ id: string }>();
  const organizationId = platform?.id ?? "";
  const by = await setup.api.getSession(byToken);
  if (!by) throw new Error("no session");
  const role = await env.DB.prepare(
    "SELECT id FROM ta_organization_role WHERE name = 'auditor'",
  ).first();
  if (!role) {
    const made = await setup.api.createRole({
      user: by.user,
      organizationId,
      name: "auditor",
      rank: 1,
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
  }
  const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  const part = await setup.api.updateMemberRole({
    user: by.user,
    organizationId,
    userId: user?.id ?? "",
    role: "operator,auditor",
  });
  if (!part.ok) throw new Error(part.code);
}

/**
 * The counts of the member writes with a dynamic part on the caller and the
 * target, on the binding on 2026-10-21 (ruling 48 of plan 12k): the queries
 * of the act, the sessions it ended, and the queries of each sweep. Before
 * the fix the act did not count its role reads: the removal took 51 queries
 * and the role change 52.
 */
const DYNAMIC_REMOVE_COUNTS: [number, number, number[]] = [49, 10, [47, 47, 30]];
const DYNAMIC_ROLE_COUNTS: [number, number, number[]] = [50, 12, [47, 47, 26]];

describe("the losses of an operator outside the operator acts on D1 (ruling 63 of plan 12f)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    endings.length = 0;
  });

  it("deletes an operator with 40 impersonation sessions in 50 queries, and the sweep ends the rest", async () => {
    const sent: MailMessage[] = [];
    const extra = await on();
    const { setup, bobToken, bobId, tokens } = await fortyImpersonations(sent, extra);
    const r = await invoke(sent, "/user/delete", asUser(bobToken), {}, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // D1 Free allows 50 queries per invocation: the route, the act, and the steps after it.
    expect(r.queries).toBeLessThanOrEqual(50);
    expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(bobId).first()).toBe(
      null,
    );
    const inAct = endings.length;
    const leftBefore = await impersonations();
    expect(leftBefore).toBeGreaterThan(0);
    // The door refuses a left row before the sweep, and ends it with its stop row.
    const left = await leftToken(tokens);
    expect(await setup.api.getSession(left)).toBeNull();
    expect(await impersonations()).toBe(leftBefore - 1);
    const sweeps = await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    // Each impersonation session ends once, with one stop row of the cause.
    expect(await stopCauses()).toEqual(Array(40).fill("account_delete"));
    expect(new Set(endings.map((e) => e.id)).size).toBe(endings.length);
    // The 40 impersonation sessions and the operator's own session.
    expect(endings.length).toBe(41);
    // The act and the sweep fire account_deleted; the door fires impersonation_end once.
    expect(endings.filter((e) => e.reason === "impersonation_end").length).toBe(1);
    expect(endings.filter((e) => e.reason === "account_deleted").length).toBe(40);
    expect([r.queries, inAct, sweeps]).toEqual(DELETE_COUNTS);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });

  it("removes the platform member row of an operator with 40 impersonation sessions in 50 queries, and the sweep ends the rest", async () => {
    const sent: MailMessage[] = [];
    const extra = await on();
    const { setup, first, bobId, tokens } = await fortyImpersonations(sent, extra);
    const platform = await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
      .bind("platform-co")
      .first<{ id: string }>();
    const r = await invoke(
      sent,
      "/organizations/members/remove",
      asUser(first),
      { organizationId: platform?.id, userId: bobId },
      extra,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // D1 Free allows 50 queries per invocation: the route, the act, and the steps after it.
    expect(r.queries).toBeLessThanOrEqual(50);
    const inAct = endings.length;
    const leftBefore = await impersonations();
    expect(leftBefore).toBeGreaterThan(0);
    // The door refuses a left row before the sweep, and ends it with its stop row.
    const left = await leftToken(tokens);
    expect(await setup.api.getSession(left)).toBeNull();
    expect(await impersonations()).toBe(leftBefore - 1);
    const sweeps = await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    // Each impersonation session ends once, with one stop row of the cause.
    expect(await stopCauses()).toEqual(Array(40).fill("role_loss"));
    expect(endings.map((e) => e.reason)).toEqual(Array(40).fill("impersonation_end"));
    expect(new Set(endings.map((e) => e.id)).size).toBe(40);
    // The operator keeps the own sessions: a removal ends only the impersonations.
    const own = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ? AND actor_id IS NULL",
    )
      .bind(bobId)
      .first<{ n: number }>();
    expect(own?.n).toBe(1);
    expect([r.queries, inAct, sweeps]).toEqual(REMOVE_COUNTS);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });

  for (const act of ["removal", "role change"] as const)
    it(`counts the role reads before a ${act} of an operator with dynamic roles in 50 queries (ruling 48 of plan 12k)`, async () => {
      const sent: MailMessage[] = [];
      const extra = await withDynamicRoles();
      const { first, bobId } = await fortyImpersonations(sent, extra, true);
      const platform = await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
        .bind("platform-co")
        .first<{ id: string }>();
      const organizationId = platform?.id ?? "";
      const roles = await env.DB.prepare("SELECT role FROM ta_member WHERE organization_id = ?")
        .bind(organizationId)
        .all<{ role: string }>();
      expect(roles.results.map((m) => m.role)).toEqual(["operator,auditor", "operator,auditor"]);
      expect(await impersonations()).toBe(40);
      const r =
        act === "removal"
          ? await invoke(
              sent,
              "/organizations/members/remove",
              asUser(first),
              { organizationId, userId: bobId },
              extra,
            )
          : await invoke(
              sent,
              "/organizations/members/role",
              asUser(first),
              { organizationId, userId: bobId, role: "auditor" },
              extra,
            );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // D1 Free allows 50 queries per invocation: the route, the role reads, the act, and the steps after it.
      expect(r.queries).toBeLessThanOrEqual(50);
      const inAct = endings.length;
      const sweeps = await sweepAll(sent, extra);
      expect(await impersonations()).toBe(0);
      // Each impersonation session ends once, with one stop row of the cause.
      expect(await stopCauses()).toEqual(Array(40).fill("role_loss"));
      expect(endings.map((e) => e.reason)).toEqual(Array(40).fill("impersonation_end"));
      expect(new Set(endings.map((e) => e.id)).size).toBe(40);
      expect([r.queries, inAct, sweeps]).toEqual(
        act === "removal" ? DYNAMIC_REMOVE_COUNTS : DYNAMIC_ROLE_COUNTS,
      );
      expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
    });

  it("keeps the own session of a removed operator through a later revoke (ruling 65 of plan 12f)", async () => {
    const sent: MailMessage[] = [];
    const extra = await on();
    const { setup, first, bobId } = await fortyImpersonations(sent, extra);
    const platform = await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
      .bind("platform-co")
      .first<{ id: string }>();
    const r = await invoke(
      sent,
      "/organizations/members/remove",
      asUser(first),
      { organizationId: platform?.id, userId: bobId },
      extra,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The removal leaves impersonation sessions, so it writes a pending-end row with targets.
    const rows = await env.DB.prepare(
      "SELECT data FROM ta_verification WHERE purpose = 'session-end' AND identifier = ?",
    )
      .bind(bobId)
      .all<{ data: string }>();
    expect(rows.results.map((row) => Array.isArray(JSON.parse(row.data).targets))).toEqual([true]);
    const ownCount = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ? AND actor_id IS NULL",
        )
          .bind(bobId)
          .first<{ n: number }>()
      )?.n;
    expect(await ownCount()).toBe(1);
    const leftBefore = await impersonations();
    endings.length = 0;
    // The ex-operator holds no platform role: the revoke changes nothing.
    const rv = await setup.api.operator.platformRole.revoke({
      actor: APP,
      userId: bobId,
      reason: "Left the support team",
      ip: null,
      userAgent: null,
    });
    expect(rv.ok).toBe(true);
    expect(await ownCount()).toBe(1);
    expect(endings).toEqual([]);
    expect(await impersonations()).toBe(leftBefore);
  });

  // A user with both kinds of pending-end row (rereview2 of plan 12f, L1).
  // Two flows write the rows in the two orders. In each order a revoke
  // retry must read the own row and end own sessions. So a read of one row
  // alone fails one of the two cases.
  const BOTH: [string, string[]][] = [
    ["a revoke that leaves both rows", ["targets", "own"]],
    ["a revoke, a grant, and a removal", ["own", "targets"]],
  ];
  it.each(BOTH)("ends own sessions on a revoke retry after %s", async (flow, order) => {
    const sent: MailMessage[] = [];
    const extra = {
      ...(await on()),
      totp: { gate: { magicLink: false } },
    } satisfies Partial<AuthConfig>;
    const role = (grant: boolean) =>
      invoke(
        sent,
        "/operator/users/platform-role",
        asSecret,
        { userId: bobId, grant, reason: "Change of the support team" },
        extra,
      );
    let bobId = "";
    if (flow === "a revoke that leaves both rows") {
      const made = await fortyImpersonations(sent, extra);
      bobId = made.bobId;
      // 60 own sessions: more than one act can end inside its budget.
      await signIns(made.setup, sent, "bob@example.com", 60);
      const r = await role(false);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } else {
      // The own row first: a revoke of an operator with 60 own sessions and no impersonation.
      const { auth: setup } = await engine(env.DB, sent, undefined, extra);
      const first = await platformOperator(setup, sent);
      await platformOperator(setup, sent, "bob@example.com");
      bobId = (await signIns(setup, sent, "bob@example.com", 60)).userId;
      const r = await role(false);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Then a grant, a fresh session, 40 impersonation sessions, and a removal.
      const g = await role(true);
      expect(g.status, JSON.stringify(g.body)).toBe(200);
      const fresh = (await signIns(setup, sent, "bob@example.com", 1)).token;
      const targets: string[] = [];
      for (let i = 0; i < 10; i++)
        targets.push((await signIns(setup, sent, `user${i}@example.com`, 1)).userId);
      for (let i = 0; i < 40; i++) {
        current = new Date(current.getTime() + 3 * 60_000);
        const bob = await setup.api.getSession(fresh);
        if (!bob) throw new Error("the session ended");
        const s = await setup.api.operator.impersonate({
          operator: bob,
          userId: targets[i % 10] ?? "",
          reason: `Ticket ${i}`,
          ip: null,
          userAgent: null,
        });
        if (!s.ok) throw new Error(s.code);
      }
      const platform = await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
        .bind("platform-co")
        .first<{ id: string }>();
      const m = await invoke(
        sent,
        "/organizations/members/remove",
        asUser(first),
        { organizationId: platform?.id, userId: bobId },
        extra,
      );
      expect(m.status, JSON.stringify(m.body)).toBe(200);
    }
    // The kinds of the rows in the order of their writes.
    const rows = await env.DB.prepare(
      "SELECT data FROM ta_verification WHERE purpose = 'session-end' AND identifier = ? ORDER BY rowid",
    )
      .bind(bobId)
      .all<{ data: string }>();
    expect(
      rows.results.map((row) => (Array.isArray(JSON.parse(row.data).targets) ? "targets" : "own")),
    ).toEqual(order);
    const ownCount = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ? AND actor_id IS NULL",
        )
          .bind(bobId)
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await ownCount();
    expect(before).toBeGreaterThan(0);
    endings.length = 0;
    // The retry: the user holds no platform role, and the own row still counts.
    const retry = await role(false);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.queries).toBeLessThanOrEqual(50);
    expect(await ownCount()).toBeLessThan(before);
    expect(endings.length).toBeGreaterThan(0);
  });
});
