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
/** The key that gives the SQL of a statement under a counting view. */
const SQL = Symbol("sql");

/**
 * A view of `db` that counts each statement it runs, and each statement of a
 * batch. `last` is the SQL of the last statement that it counted.
 */
function counting(db: D1Database) {
  const count = { queries: 0, last: "" };
  const wrapStatement = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind")
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            count.queries++;
            count.last = sql;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          count.queries += statements.length;
          count.last =
            (statements.at(-1) as unknown as Record<symbol, string> | undefined)?.[SQL] ?? "";
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

/**
 * One route call as one invocation on a counting view: the status, the body,
 * the queries, and the SQL of the last query.
 */
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
    last: count.last,
  };
}

/**
 * Sweeps, one invocation each, until no pending-end row stays: the queries
 * of each sweep. The pending rows of the solo organizations of an account
 * delete count too (ruling 78 of plan 12d).
 */
async function sweepAll(sent: MailMessage[], extra: Partial<AuthConfig> = {}) {
  const queries: number[] = [];
  for (;;) {
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_verification WHERE purpose IN ('session-end', 'organization-rest')",
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
 * 49. A probe on the binding the same day gave the account delete of a user
 * with one solo organization. It sent 41 queries before the change and 44
 * after. Plan 12d ruling 30 reads the memberships once before any write. So
 * the act reserves one more call, and its page ends one session fewer. The
 * run of 2026-10-21 gives 48 queries, 2 sessions, and sweeps of 47, 47, and 46.
 * Plan 12d Task 10 (ruling 25) reads the user's scimUser rows for their
 * scimGroupMember rows, and reserves 2 calls for it. The run of 2026-10-22
 * gives 49 queries, 2 sessions, and the same sweeps.
 * Ruling 50 of plan 12d adds the pending-end read of `revokedFor` to the
 * worst session read, so each act keeps 1 more call before it. The run of
 * 2026-10-22 gives the delete 47 queries, 1 session, and sweeps of 47, 47,
 * and 48. The removal sends 50 queries with the one more read, and its
 * page still ends 11.
 * The rebase of plan 12d Task 10 onto Task 8 raises `MEMBER_WRITE_CALLS_BEFORE`
 * from 10 to 12 for the due refresh and its session-cap read. The run of
 * 2026-10-22 gives the removal 48 queries, 10 sessions, and sweeps of 47, 47,
 * and 28. `DELETE_CALLS_BEFORE` goes from 7 to 8; the delete counts stay.
 * Ruling 78 of plan 12d (run of 2026-10-24): the handler's session read
 * takes the row of the router, so each act sends 1 query fewer. The delete
 * sends 3 more fewer: the lock starts from the user of the session, and the
 * outbox update goes. `DELETE_CALLS_BEFORE` goes from 8 to 7, and the
 * client link delete goes. So the page of the delete ends 1 session more.
 * Ruling 79 of plan 12d (run of 2026-10-24): `endSessions` reads the
 * sessions of the user once for the stop rows and the hook list. So the
 * delete reserves the same and sends 1 query fewer before its page, and the
 * page ends 1 session more: 46 queries, 3 sessions, sweeps of 47, 47, and 44.
 */
const DELETE_COUNTS: [number, number, number[]] = [46, 3, [47, 47, 44]];
const REMOVE_COUNTS: [number, number, number[]] = [47, 10, [47, 47, 28]];

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
 * and the role change 52. Ruling 50 of plan 12d adds the pending-end read
 * of `revokedFor` to the session read (run of 2026-10-22): the removal reads
 * it and sends 50 queries, and the role change keeps 1 more call and ends 1
 * session fewer. `MEMBER_WRITE_CALLS_BEFORE` at 12 (the rebase of plan 12d
 * Task 10 onto Task 8, run of 2026-10-22) keeps 2 more calls, so each page
 * ends 1 session fewer. Since ruling 78 of plan 12d (run of 2026-10-24),
 * the handler takes the session row of the router: 1 query fewer each.
 */
const DYNAMIC_REMOVE_COUNTS: [number, number, number[]] = [47, 9, [47, 47, 32]];
const DYNAMIC_ROLE_COUNTS: [number, number, number[]] = [46, 10, [47, 47, 30]];

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

  /**
   * The worst session read before the act: a due refresh that reads the
   * session-cap row with `sso.saml` on (ruling 44 of plan 12d). The slide
   * is 72 minutes, so the caller's session is due 80 minutes after the last
   * impersonation start, while each impersonation (240 minutes) still lives.
   * Run of 2026-10-22 (the rebase of plan 12d Task 10 onto Task 8): with
   * `MEMBER_WRITE_CALLS_BEFORE` at 10 the removal sent 52 queries; at 12 it
   * sends 50 and its page ends 10. The delete sends 49 with
   * `DELETE_CALLS_BEFORE` at 7 or 8. It ends the own session only: the
   * budget left for the page is below the 3 calls of its least page, so
   * the sweep ends the 40. Ruling 78 of plan 12d (run of 2026-10-24) takes
   * 2 calls from the session read and the lock, 2 from the outbox update,
   * and 1 from the client link delete. So the delete sends 47 and ends 1
   * impersonation session, and the removal sends 49. Ruling 79 of plan 12d
   * (same day) takes 1 session read from `endSessions`: the delete sends 48
   * and ends 2 impersonation sessions.
   */
  const dueWithSaml = async () =>
    ({
      ...(await on()),
      session: { slidingRefreshDays: 0.05 },
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    }) satisfies Partial<AuthConfig>;
  const DUE_DELETE_COUNTS: [number, number, number[]] = [48, 3, [48, 48, 47]];
  const DUE_REMOVE_COUNTS: [number, number, number[]] = [49, 10, [48, 48, 31]];

  it("deletes an operator with a due refresh and sso.saml on in 50 queries, and the sweep ends the rest", async () => {
    const sent: MailMessage[] = [];
    const extra = await dueWithSaml();
    const { bobToken, bobId } = await fortyImpersonations(sent, extra);
    current = new Date(current.getTime() + 80 * 60_000);
    const r = await invoke(sent, "/user/delete", asUser(bobToken), {}, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(bobId).first()).toBe(
      null,
    );
    const inAct = endings.length;
    const sweeps = await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    expect(await stopCauses()).toEqual(Array(40).fill("account_delete"));
    expect([r.queries, inAct, sweeps]).toEqual(DUE_DELETE_COUNTS);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });

  /**
   * The confirm of a mailed delete in the same scene (ruling 52 item 2 of
   * plan 12d). With the spend as an update, the confirm sent 51 queries:
   * the spend cost 2 on D1, so no page fit, and the fixed part alone passed
   * 50. The spend is a delete now, 1 statement. Measured on 2026-10-24.
   * Ruling 78 of plan 12d (same day): 48 queries, and the page ends 1
   * impersonation session. Ruling 79 (same day): `endSessions` reads the
   * sessions once, so 47 queries, and still no page fits.
   */
  const DUE_CONFIRM_COUNTS: [number, number] = [47, 2];

  it("confirms a mailed delete of an operator with a due refresh and sso.saml on in 50 queries", async () => {
    const sent: MailMessage[] = [];
    const extra = {
      ...(await dueWithSaml()),
      account: { deleteConfirm: { ttlMinutes: 1440 } },
    } satisfies Partial<AuthConfig>;
    const { bobToken, bobId } = await fortyImpersonations(sent, extra);
    const asked = await invoke(sent, "/user/delete", asUser(bobToken), {}, extra);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const text = sent.filter((m) => m.text.includes("/user/delete/confirm")).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    current = new Date(current.getTime() + 80 * 60_000);
    const r = await invoke(sent, "/user/delete/confirm", asUser(bobToken), { token }, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(bobId).first()).toBe(
      null,
    );
    const inAct = endings.length;
    await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    expect([r.queries, inAct]).toEqual(DUE_CONFIRM_COUNTS);
    expect(r.queries).toBeLessThanOrEqual(50);
  });

  it("removes the platform member row of an operator with a due refresh and sso.saml on in 50 queries", async () => {
    const sent: MailMessage[] = [];
    const extra = await dueWithSaml();
    const { first, bobId } = await fortyImpersonations(sent, extra);
    current = new Date(current.getTime() + 80 * 60_000);
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
    const inAct = endings.length;
    const sweeps = await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    expect(await stopCauses()).toEqual(Array(40).fill("role_loss"));
    expect([r.queries, inAct, sweeps]).toEqual(DUE_REMOVE_COUNTS);
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

/**
 * The queries of `POST /user/delete` by the owner of one solo organization,
 * through the route, on the binding (ruling 78 of plan 12d, measured
 * 2026-10-24). The worst caller has a `session.afterEnd` hook and the
 * impersonation tool on. Before ruling 78 the scenes sent 55 (no refresh,
 * the tool off), 59 (a due refresh with `sso.saml` on), 60 (the confirm of
 * that scene), and 64 (an operator with 40 impersonation sessions in that
 * scene). The act now takes the rows of the organization
 * that give access, and its member rows, and the sweep takes the rest
 * (organization-rest.ts in core). The list of each scene is in the comment
 * above `LAST_MODELS` in account-delete.ts. The pins are the queries of the
 * act and of each sweep, until no pending row stays. Ruling 79 of plan 12d
 * (same day): the confirm of the operator scene sent 51, and its query 51
 * was the read of the back-channel outbox. `endSessions` now reads the
 * sessions once, so each scene sends 1 fewer, and that confirm sends 50.
 */
const SOLO_COUNTS = {
  plain: [42, [30]],
  due: [44, [31]],
  confirm: [45, [31]],
  operator: [49, [48, 48, 48, 35]],
  operatorConfirm0: [50, [48, 48, 48, 35]],
  operatorConfirm3: [50, [48, 48, 48, 37]],
} as const satisfies Record<string, readonly [number, readonly number[]]>;

/**
 * A plain user who owns one solo organization, on the engine of `extra`.
 * The organization holds one team, the row that a team create writes with
 * teams on: the sweep takes it.
 */
async function soloOwner(sent: MailMessage[], extra: Partial<AuthConfig>) {
  const { auth: setup } = await engine(env.DB, sent, undefined, extra);
  const { token, userId } = await signIns(setup, sent, "solo@example.com", 1);
  const s = await setup.api.getSession(token);
  if (!s) throw new Error("no session");
  const made = await setup.api.createOrganization({ user: s.user, slug: "solo-0", name: "Solo" });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  await env.DB.prepare(
    "INSERT INTO ta_team (id, created_at, updated_at, organization_id, name) VALUES ('team-solo', 0, 0, ?, 'Core')",
  )
    .bind(organizationId)
    .run();
  expect(await restOf(organizationId)).toBe(1);
  return { token, userId, organizationId };
}

/** The rows of `organizationId` that the sweep takes after an account delete. */
async function restOf(organizationId: string): Promise<number> {
  let n = 0;
  for (const table of ["ta_team", "ta_invitation", "ta_scim_user", "ta_organization_role"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`)
      .bind(organizationId)
      .first<{ n: number }>();
    n += row?.n ?? 0;
  }
  return n;
}

describe("the account delete of a solo organization's owner through the route on D1 (ruling 78 of plan 12d)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    endings.length = 0;
  });

  const dueWithSaml = async () =>
    ({
      ...(await on()),
      session: { slidingRefreshDays: 0.05 },
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    }) satisfies Partial<AuthConfig>;

  for (const scene of ["plain", "due", "confirm"] as const)
    it(`deletes the owner of a solo organization in 50 queries: ${scene}`, async () => {
      const sent: MailMessage[] = [];
      const extra =
        scene === "plain"
          ? await on()
          : scene === "due"
            ? await dueWithSaml()
            : { ...(await dueWithSaml()), account: { deleteConfirm: { ttlMinutes: 1440 } } };
      const { token, userId, organizationId } = await soloOwner(sent, extra);
      let path = "/user/delete";
      let body: Record<string, string> = {};
      if (scene === "confirm") {
        const asked = await invoke(sent, "/user/delete", asUser(token), {}, extra);
        expect(asked.status, JSON.stringify(asked.body)).toBe(200);
        const text = sent.filter((m) => m.text.includes("/user/delete/confirm")).at(-1)?.text;
        path = "/user/delete/confirm";
        body = { token: decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text ?? "")?.[1] ?? "") };
      }
      if (scene !== "plain") current = new Date(current.getTime() + 80 * 60_000);
      const r = await invoke(sent, path, asUser(token), body, extra);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(userId).first()).toBe(
        null,
      );
      // No access stays: the organization row and its member rows went in the act.
      const left = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM ta_organization WHERE id = ?1) + (SELECT COUNT(*) FROM ta_member WHERE organization_id = ?1) AS n",
      )
        .bind(organizationId)
        .first<{ n: number }>();
      expect(left?.n).toBe(0);
      const sweeps = await sweepAll(sent, extra);
      expect(await restOf(organizationId)).toBe(0);
      expect([r.queries, sweeps]).toEqual(SOLO_COUNTS[scene]);
      expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
    });

  it("deletes an operator with 40 impersonation sessions who owns a solo organization in 50 queries", async () => {
    const sent: MailMessage[] = [];
    const extra = await dueWithSaml();
    const { setup, bobToken, bobId } = await fortyImpersonations(sent, extra);
    const bob = await setup.api.getSession(bobToken);
    if (!bob) throw new Error("no session");
    const made = await setup.api.createOrganization({
      user: bob.user,
      slug: "bob-solo",
      name: "Bob",
    });
    if (!made.ok) throw new Error(made.code);
    current = new Date(current.getTime() + 80 * 60_000);
    const r = await invoke(sent, "/user/delete", asUser(bobToken), {}, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(bobId).first()).toBe(
      null,
    );
    const sweeps = await sweepAll(sent, extra);
    expect(await impersonations()).toBe(0);
    expect(await stopCauses()).toEqual(Array(40).fill("account_delete"));
    expect(await restOf(made.value.organization.id)).toBe(0);
    expect([r.queries, sweeps]).toEqual(SOLO_COUNTS.operator);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });
  /**
   * The worst scene (ruling 79 of plan 12d): the confirm of the operator scene, with no
   * SCIM Group and with 3. The sweep takes the groups. The last query is the read of the
   * back-channel outbox, so the delivery runs inside the 50 and the logouts need no sweep.
   */
  for (const groups of [0, 3] as const)
    it(`confirms the delete of an operator with 40 impersonation sessions who owns a solo organization with ${groups} SCIM Groups in 50 queries`, async () => {
      const sent: MailMessage[] = [];
      const extra = {
        ...(await dueWithSaml()),
        account: { deleteConfirm: { ttlMinutes: 1440 } },
      } satisfies Partial<AuthConfig>;
      const { setup, bobToken, bobId } = await fortyImpersonations(sent, extra);
      const bob = await setup.api.getSession(bobToken);
      if (!bob) throw new Error("no session");
      const made = await setup.api.createOrganization({
        user: bob.user,
        slug: "bob-solo",
        name: "Bob",
      });
      if (!made.ok) throw new Error(made.code);
      const organizationId = made.value.organization.id;
      for (let i = 0; i < groups; i++)
        await env.DB.prepare(
          "INSERT INTO ta_scim_group (id, created_at, updated_at, organization_id, display_name, display_name_key, version) VALUES (?, 0, 0, ?, ?, ?, 1)",
        )
          .bind(`group-${i}`, organizationId, `Group ${i}`, `group ${i}`)
          .run();
      const asked = await invoke(sent, "/user/delete", asUser(bobToken), {}, extra);
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      const text = sent.filter((m) => m.text.includes("/user/delete/confirm")).at(-1)?.text ?? "";
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
      current = new Date(current.getTime() + 80 * 60_000);
      const r = await invoke(sent, "/user/delete/confirm", asUser(bobToken), { token }, extra);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await env.DB.prepare("SELECT id FROM ta_user WHERE id = ?").bind(bobId).first()).toBe(
        null,
      );
      expect(r.last).toMatch(/^SELECT .* FROM ta_oauth_logout WHERE user_id = \?/);
      const sweeps = await sweepAll(sent, extra);
      expect(await impersonations()).toBe(0);
      expect(await stopCauses()).toEqual(Array(40).fill("account_delete"));
      expect(await restOf(organizationId)).toBe(0);
      const g = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM ta_scim_group WHERE organization_id = ?",
      )
        .bind(organizationId)
        .first<{ n: number }>();
      expect(g?.n).toBe(0);
      expect([r.queries, sweeps]).toEqual(
        SOLO_COUNTS[groups === 0 ? "operatorConfirm0" : "operatorConfirm3"],
      );
      expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
    });
});
