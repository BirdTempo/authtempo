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

// The operator update and the operator delete on real D1 (ruling 1 of plan
// 12f2, items B1 and B2). D1 Free allows 50 queries per invocation (D1
// limits page updated 21 April 2026, read 2026-10-21). Workers Free allows
// 50 subrequests per invocation, and a mail or a post is one (Workers
// limits page updated 12 October 2026, read 2026-10-21). The view of the
// binding refuses query 51 as D1 Free does.
//
// The tests of `auth.api` add the calls of the route before the act by
// hand (`ROUTE_BEFORE`). The ready check runs in the act, on the counting
// view. Since plan 12f2 Task 5 the last tests call the operator routes
// through `auth.handle` with the D1 limiter on the same view, so each
// limiter statement counts as D1 counts it.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const REDIRECT = "https://client.example.com/callback";
const APP = { kind: "app", name: "support-tool" } as const;
const ERASURE = { kind: "secret", name: "erasure", scopes: ["users", "delete"] } as const;
const SUPPORT = { kind: "secret", name: "support", scopes: ["users"] } as const;
const REASON = { reason: "Ticket 4521", ip: null, userAgent: null };
/** The reason of a route body. */
const ROUTE_REASON = { reason: "Ticket 4521" };

/**
 * The calls of the route of a secret before the act: the limiter per IP
 * and the limiter per secret (`OPERATOR_CALLS_BEFORE.secret`, 2), and the
 * per-actor limiter of plan 12f2 Task 5 (1).
 */
const ROUTE_BEFORE = 3;

/**
 * The calls of the route of a platform operator (a user actor) before the
 * act: `OPERATOR_CALLS_BEFORE.user` (9: the impersonation step of the
 * router, the route limiter, `resolveSession`, and the guard) and the
 * per-actor limiter of plan 12f2 Task 5 (1). The D1 test
 * operator-sessions-budget.test.ts counts the 9 on the binding.
 */
const USER_ROUTE_BEFORE = 10;

/** The key that gives the statement of the binding under a counting view. */
const RAW = Symbol("raw");
/** The key that gives the SQL text of a statement under a counting view. */
const SQL = Symbol("sql");

/**
 * A view of `db` that counts each statement, and each statement of a
 * batch, with its SQL text in `count.sql`. Query `cap + 1` throws.
 */
function counting(db: D1Database, cap = Number.POSITIVE_INFINITY) {
  const count = { queries: 0, refused: 0, sql: [] as string[] };
  const tick = (texts: string[]) => {
    if (count.queries + texts.length > cap) {
      count.refused++;
      throw new Error("Too many API requests by single worker invocation.");
    }
    count.queries += texts.length;
    count.sql.push(...texts);
  };
  const wrapStatement = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind")
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick([sql]);
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
          tick(statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")));
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
/** Each post of a logout token: its URI. */
const posts: string[] = [];
/** The session ends that the hook saw, across all invocations of one test. */
const endings: { id: string; reason: string }[] = [];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The engine on `db`: the OAuth provider with back-channel logout, a
 * `session.afterEnd` hook, the platform organization, and the user tools
 * with impersonation. Each call makes a new adapter: one invocation. By
 * default the limiter allows all: the route limiters count in
 * `ROUTE_BEFORE`. A route test passes the D1 limiter on `db`.
 */
async function engine(
  db: D1Database,
  sent: MailMessage[],
  limiter: AuthConfig["limiter"] = { allow: async () => true },
) {
  const input: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
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
    oauth: {
      resources: [`${BASE}/mcp`],
      scopes: { "mcp:read": "Read" },
      registration: { cimd: false, dynamic: true },
      fetch: (async (url: string | URL | Request) => {
        posts.push(String(url));
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
    operator: {
      secrets: [
        {
          name: "erasure",
          secretHash: await sha256Hex("operator-erasure-0123456789abcdef-0123"),
          scopes: ["users", "delete"],
        },
        {
          name: "support",
          secretHash: await sha256Hex("operator-support-0123456789abcdef-0123"),
          scopes: ["users"],
        },
      ],
      users: true,
      impersonation: { ttlMinutes: 240 },
    },
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          endings.push({ id: session.id, reason });
        },
      },
    },
  };
  return createAuth(input);
}
type Auth = Awaited<ReturnType<typeof engine>>;

/** `count` sign-ins of one address by a magic link: the user id and each token. */
async function signIns(auth: Auth, sent: MailMessage[], email: string, count: number) {
  let userId = "";
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
    tokens.push(r.value.token);
    // Each row gets its own millisecond, so a read by id has one order in every run.
    current = new Date(current.getTime() + 1);
  }
  return { userId, tokens };
}

/** A client of the register route with a back-channel URI. */
async function client(auth: Auth, name: string): Promise<string> {
  const res = await auth.handle(
    new Request(`${BASE}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        backchannel_logout_uri: `https://client.example.com/bc/${name}`,
      }),
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The code flow with an ID token for the session of `token`: the token step links the session to the client. */
async function link(auth: Auth, token: string, clientId: string) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const cookie = `__Host-tempo_session=${token}`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid mcp:read offline_access",
    resource: `${BASE}/mcp`,
    state: "st-1",
    nonce: "n-1",
  });
  const page = await auth.handle(
    new Request(`${BASE}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  let location = page.headers.get("location");
  if (page.status === 200) {
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const done = await auth.handle(
      new Request(`${BASE}/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE,
          cookie,
        },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    location = done.headers.get("location");
  }
  const code = new URL(location ?? "").searchParams.get("code");
  if (!code) throw new Error("no code");
  const res = await auth.handle(
    new Request(`${BASE}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: `${BASE}/mcp`,
      }).toString(),
    }),
  );
  if (res.status !== 200) throw new Error(`token answered ${res.status}`);
}

/**
 * A platform operator through the flows: `createAdmin`, a magic link
 * sign-in, the first password, and the email method of the second factor.
 * Answers the token of a fresh session.
 */
async function platformOperator(auth: Auth, sent: MailMessage[], email: string) {
  const made = await auth.api.operator.createAdmin({
    actor: APP,
    email,
    reason: "First operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  const { tokens } = await signIns(auth, sent, email, 1);
  const token = tokens[0] ?? "";
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

/**
 * One invocation of the act on a counting view with a cap of 50: its
 * answer, queries, mails, and posts. With `limited` the D1 limiter runs on
 * the same view, so its statements count.
 */
async function act<T>(sent: MailMessage[], call: (auth: Auth) => Promise<T>, limited = false) {
  const { db, count } = counting(env.DB, 50);
  const auth = await engine(db, sent, limited ? createD1Limiter(db, clock) : undefined);
  const mails = sent.length;
  const before = posts.length;
  const answer = await call(auth);
  return {
    answer,
    queries: count.queries,
    refused: count.refused,
    sql: count.sql,
    mails: sent.length - mails,
    posts: posts.length - before,
  };
}

const rows = async (table: string, where = "1 = 1") =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first("n"));

/**
 * Sweeps, one invocation each, until no pending-end row, no client link,
 * and no outbox row stays: the queries and the posts of each sweep.
 */
async function sweepAll(sent: MailMessage[]) {
  const sweeps: { queries: number; posts: number }[] = [];
  for (;;) {
    const left =
      (await rows("ta_verification", "purpose = 'session-end'")) +
      (await rows("ta_oauth_session_client")) +
      (await rows("ta_oauth_logout"));
    if (left === 0) return sweeps;
    if (sweeps.length >= 30) throw new Error("the sweep makes no progress");
    const r = await act(sent, (auth) => auth.api.sweepExpired());
    expect(r.refused).toBe(0);
    sweeps.push({ queries: r.queries, posts: r.posts });
    current = new Date(current.getTime() + 60_000);
  }
}

/**
 * The counts of the runs on the binding on 2026-10-22 at main 09076c36.
 * Each act: the queries of the act with the route before it, the mails
 * and posts, and the sessions that the act ended. Each sweep: its queries
 * with its posts. The page of each act takes the calls that stay, so each
 * act reaches 50 exactly. A first run counted the outbox update as 1 call:
 * the load act then made 51 (an update in a D1 transaction is a batch of 2).
 * Each sign-in and each link gets its own millisecond: with one time for
 * all, the order of the rows changed the sweep counts from run to run.
 */
// Ruling 5 of plan 12f2 (2026-10-24) took the target read out of the
// delete. The load act then ends 6 sessions, was 5, and its last sweep is
// 28, was 29. The operator act makes 49, was 50: a page ends whole sessions.
// The move of 12f2 onto main 7d77a7de (2026-10-25) carries plan 12d: the
// solo organizations go set-based in 6 calls for any count, the act locks
// no outbox row, and the operator delete reads the memberships before its
// act (ruling 30 of plan 12d). The page of each act ends whole sessions,
// so no act reaches 50 exactly. The runs of 2026-10-25 give these counts.
const LOAD_COUNTS = { act: 49, inAct: 8, sweeps: [48, 48, 48, 48, 36] };
const OPERATOR_COUNTS = { act: 48, inAct: 4, sweeps: [48, 48, 39] };

/**
 * The solo organizations of the load. Until the move onto main each cost
 * 2 reads of the organization rule and 10 statements of its delete, so 2
 * did not fit. Since the move they go set-based in 6 calls for any count
 * (ruling 30 of plan 12d): 3 cost the calls of 1.
 */
const LOAD_SOLOS = 1;

/**
 * The most organizations that the user owns with another owner that the
 * delete of the load takes for a secret, measured on the binding on
 * 2026-10-25. Each costs 3 calls of the least work: the owner lock, a batch
 * of 2 on D1, and the recount. So the next one passes the budget. Since the
 * move onto main a plain membership costs no call: the organization rule
 * reads in 3 calls for any count (ruling 30 of plan 12d). Until the move
 * each membership cost 2 reads, and 3 fit.
 */
const EDGE_OWNED = 3;

/**
 * The solo organizations that the operator delete of the load takes for a
 * user actor (ruling 5 of plan 12f2). Its work budget is the smallest: 50,
 * less 11 before the act, the read of the memberships, and the audit row.
 * Measured on the binding on 2026-10-25: with 1 solo organization or more,
 * no organization that the user owns with another owner fits. With none,
 * 2 fit, as the 6 calls of the solo organizations are those of 2.
 */
const USER_SOLOS = 1;

/**
 * The counts of the user-actor deletes on the binding on 2026-10-25, by
 * solo organizations: the act with the route before it, and the sessions
 * that it ended. With a solo organization the page gets its least: the read
 * and the pending-end row, and the sweep ends the rest.
 */
const USER_COUNTS = [
  { solos: 0, act: 47, inAct: 7 },
  { solos: 1, act: 47, inAct: 0 },
  { solos: 3, act: 47, inAct: 0 },
];

describe("the operator delete on D1 in 50 calls (ruling 1 of plan 12f2)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    endings.length = 0;
    posts.length = 0;
    current = new Date("2026-10-21T00:00:00.000Z");
  });

  /**
   * A user with 60 sessions, 10 of them linked to a client with
   * back-channel logout, and `solos` organizations that the user alone
   * holds. The hook of `session.afterEnd` listens.
   */
  async function loaded(sent: MailMessage[], solos: number) {
    const setup = await engine(env.DB, sent);
    const { userId, tokens } = await signIns(setup, sent, "ada@example.com", 60);
    for (let i = 0; i < 10; i++) {
      await link(setup, tokens[i] ?? "", await client(setup, `c${i}`));
      current = new Date(current.getTime() + 1);
    }
    const session = await setup.api.getSession(tokens.at(-1) ?? "");
    if (!session) throw new Error("no session");
    const organizations: string[] = [];
    for (let i = 0; i < solos; i++) {
      const made = await setup.api.createOrganization({
        user: session.user,
        slug: `solo-${i}`,
        name: `Solo ${i}`,
      });
      if (!made.ok) throw new Error(made.code);
      organizations.push(made.value.organization.id);
    }
    expect(await rows("ta_session")).toBe(60);
    expect(await rows("ta_oauth_session_client")).toBe(10);
    endings.length = 0;
    return { setup, userId, tokens, organizations };
  }

  /** `count` organizations of other users, each with the user as a member of `role`. */
  async function memberships(
    setup: Auth,
    sent: MailMessage[],
    userId: string,
    count: number,
    role: "member" | "owner" = "member",
  ) {
    for (let i = 0; i < count; i++) {
      const owner = await signIns(setup, sent, `owner${i}@example.com`, 1);
      const session = await setup.api.getSession(owner.tokens[0] ?? "");
      if (!session) throw new Error("no session");
      const made = await setup.api.createOrganization({
        user: session.user,
        slug: `team-${i}`,
        name: `Team ${i}`,
      });
      if (!made.ok) throw new Error(made.code);
      const added = await setup.api.addMember({
        user: session.user,
        organizationId: made.value.organization.id,
        userId,
        role,
      });
      if (!added.ok) throw new Error(added.code);
    }
    endings.length = 0;
  }

  it(`deletes a user with 60 sessions, 10 client links, and ${LOAD_SOLOS} solo organization in 50 calls, and the sweeps end the rest`, async () => {
    const sent: MailMessage[] = [];
    const { setup, userId, tokens, organizations } = await loaded(sent, LOAD_SOLOS);
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId, ...REASON }),
    );
    expect(r.answer).toEqual({ ok: true, value: { organizations, auditId: expect.any(String) } });
    expect(r.refused).toBe(0);
    // The notice is one mail; the act posts no logout (ruling 37 of plan 12f).
    expect([r.mails, r.posts]).toEqual([1, 0]);
    const calls = ROUTE_BEFORE + r.queries + r.mails + r.posts;
    expect(calls).toBeLessThanOrEqual(50);
    const inAct = endings.length;
    expect(await rows("ta_user", `id = '${userId}'`)).toBe(0);
    // The doors refuse every left session before the sweep.
    for (const token of tokens) expect(await setup.api.getSession(token)).toBeNull();
    const sweeps = await sweepAll(sent);
    for (const s of sweeps) expect(s.queries + s.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_session")).toBe(0);
    // Each session ends once with account_deleted, and each link logs out once.
    expect(endings.length).toBe(60);
    expect(new Set(endings.map((e) => e.id)).size).toBe(60);
    expect(new Set(endings.map((e) => e.reason))).toEqual(new Set(["account_deleted"]));
    expect(posts.length).toBe(10);
    expect(new Set(posts).size).toBe(10);
    expect({ act: calls, inAct, sweeps: sweeps.map((s) => s.queries + s.posts) }).toEqual(
      LOAD_COUNTS,
    );
  }, 300_000);

  it("deletes 3 solo organizations in the calls of 1: they go set-based (ruling 30 of plan 12d)", async () => {
    const sent: MailMessage[] = [];
    const { userId, organizations } = await loaded(sent, 3);
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId, ...REASON }),
    );
    expect(r.answer).toEqual({
      ok: true,
      value: { organizations: [...organizations].sort(), auditId: expect.any(String) },
    });
    expect(r.refused).toBe(0);
    const calls = ROUTE_BEFORE + r.queries + r.mails + r.posts;
    expect({ act: calls, inAct: endings.length }).toEqual({
      act: LOAD_COUNTS.act,
      inAct: LOAD_COUNTS.inAct,
    });
    expect(await rows("ta_organization", "slug LIKE 'solo-%'")).toBe(0);
  }, 300_000);

  it(`deletes at the edge of the budget with ${EDGE_OWNED} organizations that the user owns with another owner, and the sweeps end the rest`, async () => {
    const sent: MailMessage[] = [];
    const { setup, userId, organizations } = await loaded(sent, LOAD_SOLOS);
    await memberships(setup, sent, userId, EDGE_OWNED, "owner");
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId, ...REASON }),
    );
    expect(r.answer).toEqual({ ok: true, value: { organizations, auditId: expect.any(String) } });
    expect(r.refused).toBe(0);
    expect(ROUTE_BEFORE + r.queries + r.mails + r.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_member", `user_id = '${userId}'`)).toBe(0);
    expect(await rows("ta_organization", "slug LIKE 'team-%'")).toBe(EDGE_OWNED);
    const sweeps = await sweepAll(sent);
    for (const s of sweeps) expect(s.queries + s.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_session")).toBe(EDGE_OWNED);
    expect(await rows("ta_session", `user_id = '${userId}'`)).toBe(0);
  }, 300_000);

  it(`refuses ${EDGE_OWNED + 1} organizations that the user owns with another owner with delete_too_large in 50 calls, and changes nothing`, async () => {
    const sent: MailMessage[] = [];
    const { setup, userId, tokens } = await loaded(sent, LOAD_SOLOS);
    await memberships(setup, sent, userId, EDGE_OWNED + 1, "owner");
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId, ...REASON }),
    );
    expect(r.answer).toEqual({ ok: false, code: "delete_too_large", status: 409 });
    expect(r.refused).toBe(0);
    expect(ROUTE_BEFORE + r.queries + r.mails + r.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_user", `id = '${userId}'`)).toBe(1);
    expect(await rows("ta_member", `user_id = '${userId}'`)).toBe(LOAD_SOLOS + EDGE_OWNED + 1);
    expect(await rows("ta_operator_audit", "action = 'user_delete'")).toBe(0);
    expect(endings).toEqual([]);
    expect(await setup.api.getSession(tokens.at(-1) ?? "")).not.toBeNull();
  }, 300_000);

  it("refuses 51 solo organizations with delete_too_large before any write (ruling 30 of plan 12d)", async () => {
    const sent: MailMessage[] = [];
    const { userId, organizations } = await loaded(sent, 51);
    /** Every row of every table, in a stable order: the whole store. */
    const store = async () => {
      const all: Record<string, unknown[]> = {};
      for (const t of Object.values(TABLES))
        all[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
      return all;
    };
    const before = await store();
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId, ...REASON }),
    );
    expect(r.answer).toEqual({ ok: false, code: "delete_too_large", status: 409 });
    // No write ran, so D1 had nothing to undo: every statement of the call is a read.
    expect(r.sql.filter((q) => !/^\s*SELECT\b/i.test(q))).toEqual([]);
    expect(await store()).toEqual(before);
    expect(organizations).toHaveLength(51);
  }, 300_000);

  it("deletes an operator with 40 impersonation sessions in 50 calls, and the sweeps end the rest with stop rows", async () => {
    const sent: MailMessage[] = [];
    const setup = await engine(env.DB, sent);
    await platformOperator(setup, sent, "op@example.com");
    const bobToken = await platformOperator(setup, sent, "bob@example.com");
    const targets: string[] = [];
    for (let i = 0; i < 10; i++)
      targets.push((await signIns(setup, sent, `user${i}@example.com`, 1)).userId);
    for (let i = 0; i < 40; i++) {
      current = new Date(current.getTime() + 3 * 60_000);
      const bob = await setup.api.getSession(bobToken);
      if (!bob) throw new Error("the session ended");
      const started = await setup.api.operator.impersonate({
        operator: bob,
        userId: targets[i % 10] ?? "",
        reason: `Ticket ${i}`,
        ip: null,
        userAgent: null,
      });
      if (!started.ok) throw new Error(started.code);
    }
    const bob = await setup.api.getSession(bobToken);
    if (!bob) throw new Error("the session ended");
    endings.length = 0;
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor: ERASURE, userId: bob.user.id, ...REASON }),
    );
    expect(r.answer).toMatchObject({ ok: true });
    expect(r.refused).toBe(0);
    const calls = ROUTE_BEFORE + r.queries + r.mails + r.posts;
    expect(calls).toBeLessThanOrEqual(50);
    const inAct = endings.length;
    const sweeps = await sweepAll(sent);
    for (const s of sweeps) expect(s.queries + s.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_session", "actor_id IS NOT NULL")).toBe(0);
    expect(await rows("ta_session", `user_id = '${bob.user.id}'`)).toBe(0);
    const stops = await env.DB.prepare(
      "SELECT data FROM ta_operator_audit WHERE action = 'impersonation_stop' ORDER BY id",
    ).all<{ data: string }>();
    expect(stops.results.map((s) => JSON.parse(s.data).cause)).toEqual(
      Array(40).fill("account_delete"),
    );
    // The 40 impersonation sessions and the operator's own session, each once.
    expect(endings.length).toBe(41);
    expect(new Set(endings.map((e) => e.id)).size).toBe(41);
    expect({ act: calls, inAct, sweeps: sweeps.map((s) => s.queries + s.posts) }).toEqual(
      OPERATOR_COUNTS,
    );
  }, 300_000);

  /** A platform operator in the world of `setup`, as the actor of a delete. */
  async function userActor(setup: Auth, sent: MailMessage[]) {
    const token = await platformOperator(setup, sent, "op@example.com");
    const resolved = await setup.api.getSession(token);
    if (!resolved) throw new Error("no session");
    endings.length = 0;
    return { kind: "user", user: resolved.user, session: resolved.session } as const;
  }

  for (const { solos } of USER_COUNTS)
    it(`deletes as a platform operator a user with 60 sessions and ${solos} solo organizations in 50 calls (ruling 5 of plan 12f2)`, async () => {
      const sent: MailMessage[] = [];
      const { setup, userId, tokens, organizations } = await loaded(sent, solos);
      const actor = await userActor(setup, sent);
      const r = await act(sent, (auth) =>
        auth.api.operator.users.delete({ actor, userId, ...REASON }),
      );
      expect(r.answer).toEqual({
        ok: true,
        value: { organizations: [...organizations].sort(), auditId: expect.any(String) },
      });
      expect(r.refused).toBe(0);
      expect([r.mails, r.posts]).toEqual([1, 0]);
      const calls = USER_ROUTE_BEFORE + r.queries + r.mails + r.posts;
      expect(calls).toBeLessThanOrEqual(50);
      expect(await rows("ta_user", `id = '${userId}'`)).toBe(0);
      for (const token of tokens) expect(await setup.api.getSession(token)).toBeNull();
      expect({ solos, act: calls, inAct: endings.length }).toEqual(
        USER_COUNTS.find((c) => c.solos === solos),
      );
    }, 300_000);

  it(`refuses as a platform operator ${USER_SOLOS} solo organization and 1 organization that the user owns with another owner: the edge is exact`, async () => {
    const sent: MailMessage[] = [];
    const { setup, userId } = await loaded(sent, USER_SOLOS);
    await memberships(setup, sent, userId, 1, "owner");
    const actor = await userActor(setup, sent);
    const r = await act(sent, (auth) =>
      auth.api.operator.users.delete({ actor, userId, ...REASON }),
    );
    // The owned organization adds its owner lock and its recount, 3 calls.
    expect(r.answer).toEqual({ ok: false, code: "delete_too_large", status: 409 });
    expect(r.refused).toBe(0);
    expect(USER_ROUTE_BEFORE + r.queries + r.mails + r.posts).toBeLessThanOrEqual(50);
    expect(await rows("ta_user", `id = '${userId}'`)).toBe(1);
    expect(await rows("ta_member", `user_id = '${userId}'`)).toBe(USER_SOLOS + 1);
    expect(endings).toEqual([]);
  }, 300_000);

  it("refuses as a platform operator 3 organizations that the user owns with another owner and no solo organization; 2 fit", async () => {
    for (const owned of [2, 3]) {
      await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      const sent: MailMessage[] = [];
      const { setup, userId } = await loaded(sent, 0);
      await memberships(setup, sent, userId, owned, "owner");
      const actor = await userActor(setup, sent);
      const r = await act(sent, (auth) =>
        auth.api.operator.users.delete({ actor, userId, ...REASON }),
      );
      expect(r.refused).toBe(0);
      expect(USER_ROUTE_BEFORE + r.queries + r.mails + r.posts).toBeLessThanOrEqual(50);
      expect({ owned, ok: r.answer.ok }).toEqual({ owned, ok: owned === 2 });
    }
  }, 600_000);

  it("updates a name in 50 calls", async () => {
    const sent: MailMessage[] = [];
    const setup = await engine(env.DB, sent);
    const { userId } = await signIns(setup, sent, "ada@example.com", 1);
    const r = await act(sent, (auth) =>
      auth.api.operator.users.update({ actor: SUPPORT, userId, name: "Ada", ...REASON }),
    );
    expect(r.answer).toMatchObject({ ok: true, value: { user: { id: userId, name: "Ada" } } });
    expect([r.refused, r.mails, r.posts]).toEqual([0, 0, 0]);
    // Measured 2026-10-22: the act with the route before it. The worst is 31 (updateUser).
    expect(ROUTE_BEFORE + r.queries).toBe(13);
  }, 120_000);

  it("creates a user with a verified address and a reset link in 50 calls (plan 12f2 Task 2)", async () => {
    const sent: MailMessage[] = [];
    const r = await act(sent, (auth) =>
      auth.api.operator.users.create({
        actor: SUPPORT,
        email: "ada@example.com",
        emailVerified: true,
        firstSignIn: "reset",
        ...REASON,
      }),
    );
    expect(r.answer).toMatchObject({ ok: true, value: { mailed: "reset" } });
    expect([r.refused, r.mails, r.posts]).toEqual([0, 1, 0]);
    expect(await rows("ta_user")).toBe(1);
    expect(await rows("ta_identity")).toBe(1);
    expect(await rows("ta_verification", "purpose = 'password-reset'")).toBe(1);
    // Measured 2026-10-25: 3 before the act, 6 queries (the ready check; the
    // address read, the user, the identity, and the audit row in one
    // transaction; the reset row after it), and the mail. The create has no loop and no page, so the
    // count is the same for every input.
    expect(ROUTE_BEFORE + r.queries + r.mails).toBe(10);
  }, 120_000);

  /**
   * One invocation of a route through `auth.handle`, with the D1 limiter on
   * the counting view: the status, the body, and the whole count, with each
   * mail and each post.
   */
  async function route(sent: MailMessage[], path: string, body: unknown, headers: HeadersInit) {
    return act(
      sent,
      async (auth) => {
        const res = await auth.handle(
          new Request(`${BASE}/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "cf-connecting-ip": "203.0.113.9",
              ...Object.fromEntries(new Headers(headers)),
            },
            body: JSON.stringify(body),
          }),
        );
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
      true,
    );
  }

  /**
   * The counts of the routes on the binding on 2026-10-24 (plan 12f2 Task
   * 5): each whole invocation with the router, the D1 limiter, the act,
   * and the mail. The secret delete meets 50 as the act of the load does.
   * The platform operator meets 48: the route before the act costs 8, not
   * the 10 that the budget keeps, so the page ends no session and the sweep
   * ends all. The update by a secret, then by a platform operator. The runs
   * of 2026-10-25 at the move onto main give the secret delete 49 and 8
   * sessions, and the platform operator 45: the solo organization costs 6.
   */
  const ROUTE_COUNTS = {
    secretDelete: { act: 49, inAct: 8 },
    userDelete: { act: 45, inAct: 0 },
    update: [13, 20],
  };

  const SECRET_HEADER = { authorization: "Operator operator-erasure-0123456789abcdef-0123" };
  const UPDATE_HEADER = { authorization: "Operator operator-support-0123456789abcdef-0123" };
  const cookieOf = (token: string) => ({
    cookie: `__Host-tempo_session=${token}`,
    origin: APP_ORIGIN,
  });

  it(`deletes through the route by a secret a user with 60 sessions, 10 client links, and ${LOAD_SOLOS} solo organization in 50 calls (plan 12f2 Task 5)`, async () => {
    const sent: MailMessage[] = [];
    const { userId, organizations } = await loaded(sent, LOAD_SOLOS);
    const r = await route(
      sent,
      "/operator/users/delete",
      { userId, ...ROUTE_REASON },
      SECRET_HEADER,
    );
    expect(r.answer).toEqual({ status: 200, body: { organizations, auditId: expect.any(String) } });
    expect(r.refused).toBe(0);
    expect([r.mails, r.posts]).toEqual([1, 0]);
    const calls = r.queries + r.mails + r.posts;
    expect(calls).toBeLessThanOrEqual(50);
    expect({ act: calls, inAct: endings.length }).toEqual(ROUTE_COUNTS.secretDelete);
    expect(await rows("ta_user", `id = '${userId}'`)).toBe(0);
  }, 300_000);

  it(`deletes through the route as a platform operator a user with 60 sessions and ${USER_SOLOS} solo organization in 50 calls (plan 12f2 Task 5)`, async () => {
    const sent: MailMessage[] = [];
    const { setup, userId, organizations } = await loaded(sent, USER_SOLOS);
    const token = await platformOperator(setup, sent, "op@example.com");
    endings.length = 0;
    const r = await route(
      sent,
      "/operator/users/delete",
      { userId, ...ROUTE_REASON },
      cookieOf(token),
    );
    expect(r.answer).toEqual({ status: 200, body: { organizations, auditId: expect.any(String) } });
    expect(r.refused).toBe(0);
    expect([r.mails, r.posts]).toEqual([1, 0]);
    const calls = r.queries + r.mails + r.posts;
    expect(calls).toBeLessThanOrEqual(50);
    expect({ act: calls, inAct: endings.length }).toEqual(ROUTE_COUNTS.userDelete);
    expect(await rows("ta_user", `id = '${userId}'`)).toBe(0);
  }, 300_000);

  it("updates a name through the route by a secret and as a platform operator in 50 calls (plan 12f2 Task 5)", async () => {
    const sent: MailMessage[] = [];
    const setup = await engine(env.DB, sent);
    const { userId } = await signIns(setup, sent, "ada@example.com", 1);
    const token = await platformOperator(setup, sent, "op@example.com");
    const counts: number[] = [];
    for (const headers of [UPDATE_HEADER, cookieOf(token)]) {
      const r = await route(
        sent,
        "/operator/users/update",
        { userId, name: "Ada", ...ROUTE_REASON },
        headers,
      );
      expect(r.answer).toMatchObject({ status: 200, body: { user: { id: userId, name: "Ada" } } });
      expect([r.refused, r.mails, r.posts]).toEqual([0, 0, 0]);
      counts.push(r.queries);
      current = new Date(current.getTime() + 1);
    }
    for (const c of counts) expect(c).toBeLessThanOrEqual(50);
    expect(counts).toEqual(ROUTE_COUNTS.update);
  }, 120_000);

  /**
   * The create route of plan 12f2 Task 5, second wave: each whole
   * invocation with the router, the D1 limiter (the per-actor count too),
   * the act, and the mail. An invitation by a secret, then a reset link
   * as a platform operator, then a create with no mail by a secret.
   * Measured on the binding 2026-10-25. The invitation: 3 limiter calls
   * (per IP, per secret, per actor), 5 queries (the ready check; the
   * address read, the user, the invitation row, and the audit row in one
   * transaction), and the mail: 9. The reset link as a platform operator:
   * 8 before the act with the per-actor count, 6 queries (the ready check;
   * the address read, the user, the identity, and the audit row in one
   * transaction; the reset row after it), and the mail: 15. No mail: 3
   * limiter calls and 4 queries (the ready check; the address read, the
   * user, and the audit row): 7. The create has no loop and no page, so
   * the count is the same for every input.
   */
  const CREATE_COUNTS = [9, 15, 7];

  it("creates a user through the route by a secret and as a platform operator in 50 calls (plan 12f2 Task 5)", async () => {
    const sent: MailMessage[] = [];
    const setup = await engine(env.DB, sent);
    const token = await platformOperator(setup, sent, "op@example.com");
    const counts: number[] = [];
    for (const [body, headers, mailed] of [
      [{ email: "ada@example.com", ...ROUTE_REASON }, UPDATE_HEADER, "invite"],
      [
        { email: "bea@example.com", emailVerified: true, firstSignIn: "reset", ...ROUTE_REASON },
        cookieOf(token),
        "reset",
      ],
      [{ email: "cal@example.com", firstSignIn: "none", ...ROUTE_REASON }, UPDATE_HEADER, null],
    ] as const) {
      const r = await route(sent, "/operator/users/create", body, headers);
      expect(r.answer).toEqual({
        status: 200,
        body: { userId: expect.any(String), mailed, auditId: expect.any(String) },
      });
      expect([r.refused, r.mails, r.posts]).toEqual([0, mailed === null ? 0 : 1, 0]);
      counts.push(r.queries + r.mails + r.posts);
      current = new Date(current.getTime() + 1);
    }
    for (const c of counts) expect(c).toBeLessThanOrEqual(50);
    expect(counts).toEqual(CREATE_COUNTS);
    expect(await rows("ta_verification", "purpose = 'user-invite'")).toBe(1);
    expect(await rows("ta_verification", "purpose = 'password-reset'")).toBe(1);
  }, 120_000);

  /**
   * The invitation of plan 12f2 Task 3. The create writes the row in its
   * transaction and mails the link after the commit. The confirm runs
   * through `auth.handle` with the D1 limiter: an unverified user gets the
   * claim, and a verified user only the identity read.
   *
   * Measured on the binding 2026-10-25. The create: 3 before the act, 5
   * queries (the ready check; the address read, the user, the invitation
   * row, and the audit row in one transaction), and the mail: 9. The
   * confirm of an unverified user: 27. That is the limiter, the ready
   * check, the spend (3: the read, the read of the D1 undo, the update),
   * the user read, the gate read, the session hook reads and hold (3), the
   * identity (2), the claim (10), the session, and the 4 reads of the JSON
   * answer. A verified user skips the
   * identity write and the claim: 16. The confirm has no loop and no page.
   */
  const INVITE_COUNTS = { create: 9, confirm: [27, 16] };

  it("creates a user with an invitation in 50 calls (plan 12f2 Task 3)", async () => {
    const sent: MailMessage[] = [];
    const r = await act(sent, (auth) =>
      auth.api.operator.users.create({ actor: SUPPORT, email: "ada@example.com", ...REASON }),
    );
    expect(r.answer).toMatchObject({ ok: true, value: { mailed: "invite" } });
    expect([r.refused, r.mails, r.posts]).toEqual([0, 1, 0]);
    expect(await rows("ta_verification", "purpose = 'user-invite'")).toBe(1);
    const calls = ROUTE_BEFORE + r.queries + r.mails;
    expect(calls).toBeLessThanOrEqual(50);
    expect(calls).toBe(INVITE_COUNTS.create);
  }, 120_000);

  it("confirms an invitation through the route in 50 calls (plan 12f2 Task 3)", async () => {
    const counts: number[] = [];
    for (const emailVerified of [false, true]) {
      const sent: MailMessage[] = [];
      const setup = await engine(env.DB, sent);
      const email = emailVerified ? "bea@example.com" : "ada@example.com";
      const made = await setup.api.operator.users.create({
        actor: SUPPORT,
        email,
        emailVerified,
        ...REASON,
      });
      if (!made.ok) throw new Error(made.code);
      const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
      const r = await route(sent, "/user/invite/confirm", { token }, { origin: APP_ORIGIN });
      expect(r.answer).toMatchObject({ status: 200, body: { user: { id: made.value.userId } } });
      expect([r.refused, r.mails, r.posts]).toEqual([0, 0, 0]);
      counts.push(r.queries);
      current = new Date(current.getTime() + 1);
    }
    for (const c of counts) expect(c).toBeLessThanOrEqual(50);
    expect(counts).toEqual(INVITE_COUNTS.confirm);
  }, 120_000);
});
