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

// The ban and the revoke of the platform role on real D1 (rulings 44 and 45
// of plan 12f). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-21). This test counts each statement
// that reaches the D1 binding through `auth.handle`, the D1 limiter on the
// same view, so the route, the act, and the steps after the commit all count.
// Each sweep is one invocation too, and counts the same way.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const SECRET = "operator-support-0123456789abcdef-0123";
const REASON = "Abuse case 4711";

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
 * Answers the token of a fresh session.
 */
async function platformOperator(auth: Auth, sent: MailMessage[], email = "op@example.com") {
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

async function sessionsOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditOf(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT action FROM ta_operator_audit WHERE target_user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all<{ action: string }>();
  return rows.results.map((r) => r.action);
}

/**
 * The counts of the first run on the binding, 2026-10-21: the queries of the
 * act, the sessions it ended, and the queries of each sweep. Each query count
 * is 50 or below. The user actor reads the session, the user, the refresh,
 * and the guard before the act, so its act ends fewer sessions.
 *
 * The counts changed on 2026-10-21 with plan 12f Task 11. The revoke holds
 * the user row first (ruling 42), 3 calls, so its act ends 3 sessions
 * fewer. A user actor through the route pays one more session read, the
 * impersonation step of the router, so its act ends 1 session fewer.
 */
const BAN_COUNTS: Record<string, [number, number, number[]]> = {
  "secret 45": [50, 31, [35]],
  "user 45": [49, 22, [44]],
  "secret 60": [50, 31, [48, 22]],
  "user 60": [49, 22, [48, 31]],
};
const REVOKE_COUNTS: Record<string, [number, number, number, number, number[]]> = {
  "secret 45": [50, 43, 24, 21, [20]],
  "user 45": [50, 49, 24, 19, [25]],
  "secret 60": [50, 50, 24, 28, [31]],
  "user 60": [50, 49, 24, 19, [40]],
};

const asSecret = { authorization: `Operator ${SECRET}` };
const asUser = (token: string) => ({ cookie: `__Host-tempo_session=${token}`, origin: BASE });

describe("the ban and the revoke on D1 (rulings 44 and 45 of plan 12f)", () => {
  it("gives a session from before a re-grant no operator power, and a new session acts (ruling 50)", async () => {
    const sent: MailMessage[] = [];
    // The magic link opens a session with no second factor here, so the target signs in 60 times after its factor.
    const { auth: setup } = await engine(env.DB, sent, undefined, {
      totp: { gate: { magicLink: false } },
    });
    await platformOperator(setup, sent);
    await platformOperator(setup, sent, "bob@example.com");
    const bob = await signIns(setup, sent, "bob@example.com", 60);
    const list = (token: string) =>
      setup.handle(
        new Request(`${BASE}/auth/operator/users`, {
          headers: { cookie: `__Host-tempo_session=${token}` },
        }),
      );
    expect((await list(bob.token)).status).toBe(200);
    const revoked = await invoke(sent, "/operator/users/platform-role", asSecret, {
      userId: bob.userId,
      grant: false,
      reason: REASON,
    });
    expect(revoked.status).toBe(200);
    const left = await leftToken(bob.tokens);
    // The re-grant before the sweep: the left session keeps no power from it.
    current = new Date(current.getTime() + 1);
    const granted = await setup.api.operator.platformRole.grant({
      actor: APP,
      userId: bob.userId,
      reason: REASON,
      ip: null,
      userAgent: null,
    });
    if (!granted.ok) throw new Error(granted.code);
    const old = await list(left);
    expect([old.status, await old.json()]).toEqual([403, { error: "operator_required" }]);
    // A sign-in after the re-grant acts.
    current = new Date(current.getTime() + 1);
    const fresh = await signIns(setup, sent, "bob@example.com", 1);
    expect((await list(fresh.token)).status).toBe(200);
    // The sweep still ends the left sessions, and keeps the new one.
    await sweepAll(sent);
    expect(await sessionsOf(bob.userId)).toBe(1);
  });

  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    endings.length = 0;
  });

  it("ends the left impersonation sessions of a banned target in the sweep, each with its stop row", async () => {
    const sent: MailMessage[] = [];
    const on = {
      operator: {
        secrets: [
          { name: "support", secretHash: await sha256Hex(SECRET), scopes: ["users", "sessions"] },
        ],
        users: true,
        impersonation: {},
      },
    } satisfies Partial<AuthConfig>;
    const { auth: setup } = await engine(env.DB, sent, undefined, on);
    const token = await platformOperator(setup, sent);
    const { userId } = await signIns(setup, sent, "ada@example.com", 45);
    // A core id is a ULID: a second later, the impersonation sessions sort after the 45.
    current = new Date(current.getTime() + 1000);
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
    endings.length = 0;
    const r = await invoke(sent, "/operator/users/ban", asSecret, { userId, reason: REASON }, on);
    expect(r.status).toBe(200);
    const inAct = endings.length;
    const sweeps = await sweepAll(sent, on);
    expect(await sessionsOf(userId)).toBe(0);
    const stops = await env.DB.prepare(
      "SELECT data FROM ta_operator_audit WHERE action = 'impersonation_stop' ORDER BY id",
    ).all<{ data: string }>();
    // The act ends the first page; the 3 impersonation sessions end in the sweep.
    expect(stops.results.map((s) => JSON.parse(s.data).cause)).toEqual(["ban", "ban", "ban"]);
    // The run of 2026-10-21: with the tool on, the act reads the audit table for
    // the user's own impersonations, so it ends 30, not 31. The sweep ends 15
    // sessions and writes 3 stop rows in 42 queries, inside SWEEP_CALL_BUDGET.
    expect([r.queries, inAct, sweeps]).toEqual([50, 30, [42]]);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });

  it("bans an operator with 40 impersonation sessions in 50 queries, and the sweep ends the rest with stop rows", async () => {
    const sent: MailMessage[] = [];
    const on = {
      operator: {
        secrets: [
          { name: "support", secretHash: await sha256Hex(SECRET), scopes: ["users", "sessions"] },
        ],
        users: true,
        impersonation: {},
      },
    } satisfies Partial<AuthConfig>;
    const { auth: setup } = await engine(env.DB, sent, undefined, on);
    const token = await platformOperator(setup, sent);
    const { userId: target } = await signIns(setup, sent, "ada@example.com", 1);
    const operator = await setup.api.getSession(token);
    if (!operator) throw new Error("the session ended");
    for (let i = 0; i < 40; i++) {
      const r = await setup.api.operator.impersonate({
        operator,
        userId: target,
        reason: `Ticket ${i}`,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    }
    endings.length = 0;
    const r = await invoke(
      sent,
      "/operator/users/ban",
      asSecret,
      { userId: operator.user.id, reason: REASON },
      on,
    );
    expect(r.status).toBe(200);
    const inAct = endings.length;
    const sweeps = await sweepAll(sent, on);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_session WHERE actor_id IS NOT NULL",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const stops = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_operator_audit WHERE action = 'impersonation_stop'",
    ).first<{ n: number }>();
    expect(stops?.n).toBe(40);
    // The run of 2026-10-21: the act ends a page of the impersonation sessions, each
    // with its stop row. With the operator's own sessions, it ends 12 in 46 queries. It keeps
    // calls for the own page. Three sweeps end the rest, at 48 queries or fewer each.
    expect([r.queries, inAct, sweeps]).toEqual([46, 12, [48, 48, 23]]);
    expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
  });

  for (const sessions of [45, 60])
    for (const actor of ["secret", "user"] as const)
      it(`a ${actor} bans a user with ${sessions} sessions and a hook in 50 queries or fewer, and the sweep ends the rest`, async () => {
        const sent: MailMessage[] = [];
        const { auth: setup } = await engine(env.DB, sent);
        const token = await platformOperator(setup, sent);
        const { userId } = await signIns(setup, sent, "ada@example.com", sessions);
        // Past the slide of 6 hours, inside the 1440 fresh minutes: the worst case of the session read.
        current = new Date(current.getTime() + 7 * 60 * 60 * 1000);
        endings.length = 0;
        const r = await invoke(
          sent,
          "/operator/users/ban",
          actor === "secret" ? asSecret : asUser(token),
          {
            userId,
            reason: REASON,
          },
        );
        // No rollback_failed and no throw after the commit: a 200 with the audit row.
        expect([r.status, Object.keys(r.body)], JSON.stringify(r.body)).toEqual([200, ["auditId"]]);
        expect(await auditOf(userId)).toEqual(["ban"]);
        const inAct = endings.length;
        const sweeps = await sweepAll(sent);
        expect(await sessionsOf(userId)).toBe(0);
        expect(endings.map((e) => e.reason)).toEqual(Array(sessions).fill("banned"));
        expect(new Set(endings.map((e) => e.id)).size).toBe(sessions);
        expect([r.queries, inAct, sweeps]).toEqual(BAN_COUNTS[`${actor} ${sessions}`]);
        expect(Math.max(r.queries, ...sweeps)).toBeLessThanOrEqual(50);
      });

  for (const sessions of [45, 60])
    for (const actor of ["secret", "user"] as const)
      it(`a secret revokes an operator with ${sessions} sessions in 50 queries or fewer, a ${actor} retries, and the sweep ends the rest`, async () => {
        const sent: MailMessage[] = [];
        const { auth: setup } = await engine(env.DB, sent);
        const token = await platformOperator(setup, sent);
        const { userId } = await signIns(setup, sent, "bob@example.com", sessions);
        const granted = await setup.api.operator.platformRole.grant({
          actor: APP,
          userId,
          reason: REASON,
          ip: null,
          userAgent: null,
        });
        if (!granted.ok) throw new Error(granted.code);
        current = new Date(current.getTime() + 7 * 60 * 60 * 1000);
        endings.length = 0;
        const body = { userId, grant: false, reason: REASON };
        const first = await invoke(sent, "/operator/users/platform-role", asSecret, body);
        expect([first.status, Object.keys(first.body)], JSON.stringify(first.body)).toEqual([
          200,
          ["auditId"],
        ]);
        const inAct = endings.length;
        // The role is gone, so a user actor may act on the user now (ruling 45).
        const retry = await invoke(
          sent,
          "/operator/users/platform-role",
          actor === "secret" ? asSecret : asUser(token),
          body,
        );
        expect([retry.status, Object.keys(retry.body)], JSON.stringify(retry.body)).toEqual([
          200,
          ["auditId"],
        ]);
        const inRetry = endings.length - inAct;
        expect(await auditOf(userId)).toEqual([
          "platform_role_grant",
          "platform_role_revoke",
          "platform_role_revoke",
        ]);
        const sweeps = await sweepAll(sent);
        expect(await sessionsOf(userId)).toBe(0);
        expect(endings.map((e) => e.reason)).toEqual(Array(sessions).fill("operator"));
        expect([first.queries, retry.queries, inAct, inRetry, sweeps]).toEqual(
          REVOKE_COUNTS[`${actor} ${sessions}`],
        );
        expect(Math.max(first.queries, retry.queries, ...sweeps)).toBeLessThanOrEqual(50);
      });
});
