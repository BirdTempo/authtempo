import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
// The guard of a user actor and the config resolve are not in the package
// exports: the test reads them from core's built output.
import { resolveConfig } from "../../core/dist/config.js";
import { requireOperatorUser } from "../../core/dist/engine/operator/guards.js";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The call budget of the operator session calls on real D1 (plan 12f Task 7
// review M2 and m2, ruling 34). D1 Free allows 50 queries per invocation
// (D1 limits page updated 21 April 2026, read 2026-10-21). Core counts
// port calls, and an update in a transaction as 2. This test counts each
// statement that reaches the D1 binding, each statement of a batch as one,
// so it checks that count against D1 itself.

const BASE = "https://api.example.com";
/** Every request passes: the count, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;

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
          // The batch needs the statements of the binding, not the views.
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

/**
 * The engine on `db`, with a `session.afterEnd` hook, `limiter`, and a
 * slide of 6 hours, so a read of the session after 7 hours writes its
 * refresh. Each call makes a new adapter: one invocation.
 */
function engine(
  db: D1Database,
  sent: MailMessage[],
  limiter: AuthConfig["limiter"] = OPEN,
  impersonation = false,
) {
  const storage = createD1Adapter(db);
  const input: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    clock,
    limiter,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the count of statements, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { slidingRefreshDays: 0.25 },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: impersonation ? { users: true, impersonation: {} } : { users: true },
    hooks: { session: { afterEnd: () => {} } },
  };
  return { auth: createAuth(input), storage, input };
}

/** `count` sign-ins of one address by a magic link: the user id and the token of the last session. */
async function signIns(
  auth: ReturnType<typeof engine>["auth"],
  sent: MailMessage[],
  email: string,
  count: number,
) {
  let userId = "";
  let last = "";
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
  }
  return { userId, token: last };
}

/**
 * A platform operator through the flows: `createAdmin`, a magic link
 * sign-in, the first password, and the email method of the second factor.
 * Answers the token of a fresh session.
 */
async function platformOperator(auth: ReturnType<typeof engine>["auth"], sent: MailMessage[]) {
  const email = "op@example.com";
  const made = await auth.api.operator.createAdmin({
    actor: APP,
    email,
    reason: "First operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
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
      headers: {
        "content-type": "application/json",
        cookie: `__Host-tempo_session=${token}`,
      },
      body: JSON.stringify({ password: "correct horse battery" }),
    }),
  );
  if (res.status !== 200) throw new Error(`enable answered ${res.status}`);
  return token;
}

describe("the operator session calls on D1 (plan 12f Task 7)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("an endAll of the app with a hook and a full page sends 49 queries, the schema check too", async () => {
    const sent: MailMessage[] = [];
    await signIns(engine(env.DB, sent).auth, sent, "ada@example.com", 60);
    // One invocation: a new adapter, so its first query is the schema check.
    const { db, count } = counting(env.DB);
    const invocation = engine(db, sent);
    const done = await invocation.auth.api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // The schema check, the read, the link read, 45 deletes, and the audit row. The page
    // keeps 1 call for the lock read, which D1 has no need to send (ruling 36).
    expect([done.value.ended, done.value.more, count.queries]).toEqual([45, true, 49]);
    // The counter of the adapter agrees with the binding.
    expect(invocation.storage.statementsSent?.()).toBe(49);
    // The schema check is the whole ready check of a core adapter (ruling 37).
    expect(await invocation.storage.readyStatements?.()).toBe(1);
  });

  it("an endUser of the app with a hook sends 42 queries, the hold batch too", async () => {
    const sent: MailMessage[] = [];
    const { userId } = await signIns(engine(env.DB, sent).auth, sent, "ada@example.com", 60);
    const { db, count } = counting(env.DB);
    const invocation = engine(db, sent);
    const done = await invocation.auth.api.operator.sessions.endUser({
      actor: APP,
      userId,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // A page keeps calls for the last page, so a page with a hook ends 31 sessions in 42
    // queries. The call sends no logout, so it reads no outbox row (ruling 37).
    expect([done.value.ended, done.value.more, count.queries]).toEqual([31, true, 42]);
    expect(invocation.storage.statementsSent?.()).toBe(42);
  });

  /**
   * With the impersonation on: a platform operator, one session of the
   * target, 3 impersonation sessions of the target, then 59 more sessions.
   * So the first page holds the 3 impersonation sessions (ruling 43).
   */
  async function withImpersonations(sent: MailMessage[]) {
    const setup = engine(env.DB, sent, OPEN, true).auth;
    const token = await platformOperator(setup, sent);
    const { userId } = await signIns(setup, sent, "ada@example.com", 1);
    const operator = await setup.api.getSession(token);
    if (!operator) throw new Error("the session ended");
    for (let i = 0; i < 3; i++) {
      const r = await setup.api.operator.impersonate({
        operator,
        userId,
        reason: `Ticket ${i}`,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    }
    // A core id is a ULID: rows of one millisecond sort at random. A second
    // later, the next rows sort after the impersonation sessions.
    current = new Date(current.getTime() + 1000);
    await signIns(setup, sent, "ada@example.com", 59);
    return userId;
  }

  const stopRows = async () =>
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM ta_operator_audit WHERE action = 'impersonation_stop'",
      ).first<{ n: number }>()
    )?.n;

  it("an endAll of the app with a hook and 3 impersonation sessions sends 49 queries, the stop rows too", async () => {
    const sent: MailMessage[] = [];
    await withImpersonations(sent);
    const { db, count } = counting(env.DB);
    const invocation = engine(db, sent, OPEN, true);
    const done = await invocation.auth.api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // The schema check, the read, the link read, 42 deletes, 3 stop rows, and the audit
    // row. Each impersonation session costs its delete and its stop row (ruling 43).
    expect([done.value.ended, done.value.more, count.queries]).toEqual([42, true, 49]);
    expect(invocation.storage.statementsSent?.()).toBe(49);
    expect(await stopRows()).toBe(3);
  });

  it("an endUser of the app with a hook and 3 impersonation sessions sends 42 queries, the stop rows too", async () => {
    const sent: MailMessage[] = [];
    const userId = await withImpersonations(sent);
    const { db, count } = counting(env.DB);
    const invocation = engine(db, sent, OPEN, true);
    const done = await invocation.auth.api.operator.sessions.endUser({
      actor: APP,
      userId,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    expect([done.value.ended, done.value.more, count.queries]).toEqual([28, true, 42]);
    expect(invocation.storage.statementsSent?.()).toBe(42);
    expect(await stopRows()).toBe(3);
  });

  for (const call of ["endAll", "endUser"] as const)
    it(`a whole user-actor ${call} sends 50 queries or fewer: the route limiter, the session, the guard, and the act`, async () => {
      const sent: MailMessage[] = [];
      const setup = engine(env.DB, sent).auth;
      const token = await platformOperator(setup, sent);
      const { userId } = await signIns(setup, sent, "ada@example.com", 60);
      // Past the slide of 6 hours, inside the 1440 fresh minutes of the sign-in.
      current = new Date(current.getTime() + 7 * 60 * 60 * 1000);
      const { db, count } = counting(env.DB);
      const invocation = engine(db, sent, createD1Limiter(db, clock));
      const route = createD1Limiter(db, clock);
      // The limiter of the route, as each operator route runs first.
      expect(await route.allow("operator-users:ip:203.0.113.9", { seconds: 3600, max: 600 })).toBe(
        true,
      );
      const resolved = await invocation.auth.api.getSession(token);
      if (!resolved) throw new Error("the session ended");
      const actor = await requireOperatorUser(resolveConfig(invocation.input), resolved);
      if (!actor.ok) throw new Error(actor.code);
      const before = count.queries;
      const input = { actor: actor.value, reason: "Breach", ip: null, userAgent: null };
      const done =
        call === "endAll"
          ? await invocation.auth.api.operator.sessions.endAll(input)
          : await invocation.auth.api.operator.sessions.endUser({ ...input, userId });
      if (!done.ok) throw new Error(done.code);
      // The route limiter, the schema check, the session, the user, the refresh, the
      // platform organization, the member, the factor, and the guard limiter: 9.
      expect(before).toBe(9);
      expect(done.value.more).toBe(true);
      // The whole invocation on the binding, and the counter of the adapter, which
      // leaves out the 2 limiter queries: they go to the binding, not through the adapter.
      expect([done.value.ended, count.queries, invocation.storage.statementsSent?.()]).toEqual(
        // The work keeps 1 call for the session read of the router's
        // impersonation step (plan 12f Task 11), which this direct call skips.
        call === "endAll" ? [36, 48, 46] : [20, 41, 39],
      );
    });
});
