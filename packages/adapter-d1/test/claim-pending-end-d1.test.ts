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

// The claim's bounded session delete on D1 (decision 3 of plan 12q). With an
// `afterEnd` hook a claim reads the claimant's sessions and ends them by
// chunks of 50, one query each. Before plan 12q the count of chunks had no
// bound (open point 4 of the 12p close). So a claimant with enough sessions
// pushed the owner's claim past the 50 queries of one invocation. Now a
// claim ends at most two chunks. It writes the pending-end row of a ban for
// the rest, with the reason `claimed`, and the sweep ends them with the hook.
// The rest are unproved, so each ends at its next use (ruling 13). The owner's
// session after the claim is proved, so the sweep keeps it.
//
// Every step is a real request through `auth.handle`. The counted request
// runs on a view of the binding that counts each query and refuses query
// 51, as D1 Free does. The source is the D1 limits page, updated 21 April
// 2026 and read 2026-10-24 (anonymous-upgrade-budget.test.ts).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";

// The counts of the run of 2026-11-05 08:51 CST on the owner's Mac Studio
// (load 9.30 6.99 5.27). `link` is the owner's magic link over 120 claimant
// sessions: the lease, two chunks, the pending-end row, and the cap read of
// the owner's session. `sweep` is the sweep after it, which ends the 20 that
// stayed. `reset` is the owner's reset link over 1000 claimant sessions, the
// most that the largest cap allows. Before plan 12q that reset ended all 1000
// in 20 chunks and answered 500 at query 51; the magic link sent 46.
const PINS = { link: 29, sweep: 42, reset: 40 };

/** A view of `db` that counts each statement, and each statement of a batch. Query 51 throws. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

let current = new Date("2026-11-05T00:00:00.000Z");
const clock = { now: () => current };
const mail: MailMessage[] = [];
/** Each session end of every invocation, as id and reason. */
const ends: { id: string; reason: string }[] = [];

/**
 * One invocation. A counted one runs on the view with the D1 limiter. The
 * others open the claimant's sessions with no limiter. The cap has room for
 * them: the default is 100.
 */
function make(counted: boolean, extra: Partial<AuthConfig> = {}) {
  const { db, count } = counted ? counting(env.DB) : { db: env.DB, count: { queries: 0 } };
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: counted ? createD1Limiter(db) : { allow: async () => true },
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { maxPerUser: 200 },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void ends.push({ id: session.id, reason }) },
    },
    ...extra,
  });
  return { auth, count };
}
type World = ReturnType<typeof make>;

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}

let ip = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** A GET of the routes with the headers of one session. */
const get = (path: string, headers: Record<string, string>) =>
  new Request(`${BASE}/auth${path}`, {
    headers: {
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...headers,
    },
  });

/** The bearer header of a session token. */
const bearer = (token: string | undefined) => {
  expect(token).toBeTruthy();
  return { authorization: `Bearer ${token}` };
};

/** The session cookie that an answer sets. */
function cookieOf(res: Response): Record<string, string> {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  const token = line?.slice("__Host-tempo_session=".length).split(";")[0] ?? "";
  expect(token).not.toBe("");
  return { cookie: `__Host-tempo_session=${token}` };
}

/**
 * The claimant: a sign-up of the address and `sessions - 1` sign-ins, 1 ms apart.
 * `tokens` gets the token of each session, oldest first.
 */
async function claimant(
  email: string,
  sessions: number,
  extra: Partial<AuthConfig> = {},
  tokens: string[] = [],
): Promise<string> {
  const other = make(false, extra);
  const up = await measure(other, post("/password/sign-up", { email, password: PASSWORD }));
  expect(up.res.status).toBe(200);
  tokens.push(((await up.res.json()) as { token: string }).token);
  for (let i = 1; i < sessions; i++) {
    current = new Date(current.getTime() + 1);
    const s = await measure(other, post("/password/sign-in", { email, password: PASSWORD }));
    expect(s.res.status).toBe(200);
    tokens.push(((await s.res.json()) as { token: string }).token);
  }
  const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("no user");
  return user.id;
}

/** A magic link of the address, asked for with no count: the request of its verify. */
async function link(email: string): Promise<Request> {
  current = new Date(current.getTime() + 1000);
  expect((await measure(make(false), post("/magic-link/request", { email }))).res.status).toBe(200);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  return post("/magic-link/verify", { token });
}

/** The sessions of a user by their flag, and the reasons of its pending-end rows. */
async function stateOf(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, proved FROM ta_session WHERE user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all<{ id: string; proved: number }>();
  const rows = await env.DB.prepare(
    "SELECT data FROM ta_verification WHERE purpose = 'session-end' AND identifier = ? ORDER BY id",
  )
    .bind(userId)
    .all<{ data: string }>();
  return {
    proved: results.filter((r) => r.proved === 1).map((r) => r.id),
    unproved: results.filter((r) => r.proved === 0).map((r) => r.id),
    pending: rows.results.map((r) => (JSON.parse(r.data) as { reason: string }).reason),
  };
}

describe("the claim's bounded session delete on D1 (decision 3 of plan 12q)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    mail.length = 0;
    ends.length = 0;
    current = new Date("2026-11-05T00:00:00.000Z");
  });

  it("ends two chunks of a claimant with 120 sessions inside 50 queries, and the sweep ends the rest with the reason claimed", {
    timeout: 120_000,
  }, async () => {
    const userId = await claimant("ada@example.com", 120);
    expect((await stateOf(userId)).unproved.length).toBe(120);
    const w = make(true);
    const claim = await measure(w, await link("ada@example.com"));
    expect(claim.res.status).toBe(200);
    expect(claim.queries).toBe(PINS.link);
    expect(claim.queries).toBeLessThanOrEqual(BUDGET);
    expect(ends.length).toBe(100);
    expect(new Set(ends.map((e) => e.reason))).toEqual(new Set(["claim"]));
    const after = await stateOf(userId);
    expect(after.proved.length).toBe(1);
    expect(after.unproved.length).toBe(20);
    expect(after.pending).toEqual(["claimed"]);
    // The sweep, on its own counted invocation.
    current = new Date(current.getTime() + 1000);
    const sweeper = make(true);
    sweeper.count.queries = 0;
    const result = await sweeper.auth.api.sweepExpired();
    expect(sweeper.count.queries).toBe(PINS.sweep);
    expect(sweeper.count.queries).toBeLessThanOrEqual(BUDGET);
    expect(result.pendingSessions).toBe(20);
    expect(ends.slice(100).map((e) => e.reason)).toEqual(Array(20).fill("claimed"));
    expect(new Set(ends.slice(100).map((e) => e.id))).toEqual(new Set(after.unproved));
    expect(await stateOf(userId)).toEqual({ proved: after.proved, unproved: [], pending: [] });
  });

  it("ends each session once when a ban's row waits too, and both rows go", {
    timeout: 120_000,
  }, async () => {
    // A named secret with the scope users, as the config needs. The test acts as the app.
    const tools: Partial<AuthConfig> = {
      operator: {
        secrets: [{ name: "support", secretHash: "0".repeat(64), scopes: ["users"] }],
        users: true,
      },
    };
    const userId = await claimant("cy@example.com", 160, tools);
    // A ban of an hour ends a page in its call and leaves its pending row for the rest.
    const banner = make(true, tools);
    const banned = await banner.auth.api.operator.users.ban({
      actor: { kind: "app", name: "support-tool" },
      userId,
      reason: "Abuse report 7",
      until: new Date(current.getTime() + 3_600_000).toISOString(),
      ip: null,
      userAgent: null,
    });
    expect(banned.ok).toBe(true);
    expect(banner.count.queries).toBeLessThanOrEqual(BUDGET);
    expect(ends.length).toBeGreaterThan(0);
    expect((await stateOf(userId)).unproved.length).toBeGreaterThan(100);
    expect((await stateOf(userId)).pending).toEqual(["banned"]);
    // The ban ends; the owner proves the address before any sweep.
    current = new Date(current.getTime() + 2 * 3_600_000);
    const claim = await measure(make(true, tools), await link("cy@example.com"));
    expect(claim.res.status).toBe(200);
    expect(claim.queries).toBeLessThanOrEqual(BUDGET);
    expect((await stateOf(userId)).pending).toEqual(["banned", "claimed"]);
    for (let i = 0; i < 5 && (await stateOf(userId)).pending.length > 0; i++) {
      current = new Date(current.getTime() + 1000);
      const sweeper = make(true, tools);
      await sweeper.auth.api.sweepExpired();
      expect(sweeper.count.queries).toBeLessThanOrEqual(BUDGET);
    }
    const after = await stateOf(userId);
    expect(after.pending).toEqual([]);
    expect(after.unproved).toEqual([]);
    expect(after.proved.length).toBe(1);
    // 160 claimant sessions ended, each once.
    expect(ends.length).toBe(160);
    expect(new Set(ends.map((e) => e.id)).size).toBe(160);
  });

  // Probe R3 of the Task 2 review (Major 1, ruling 23 of plan 12q). Before the
  // door of ruling 13, a leftover session listed the owner's sessions. It ended
  // them and deleted the owner's account. Now each act meets the door: 401, and
  // the session ends with the reason `claimed`. Each act uses its own leftover
  // session, so each one reaches the door and not an empty session.
  it("refuses the session list, the revoke of the others, and the account delete of a leftover session at the door", {
    timeout: 120_000,
  }, async () => {
    const tokens: string[] = [];
    const userId = await claimant("dee@example.com", 120, {}, tokens);
    expect(tokens).toHaveLength(120);
    const claim = await measure(make(true), await link("dee@example.com"));
    expect(claim.res.status).toBe(200);
    expect(claim.queries).toBe(PINS.link);
    const owner = cookieOf(claim.res);
    const mid = await stateOf(userId);
    expect(mid.proved.length).toBe(1);
    expect(mid.unproved.length).toBe(20);
    expect(mid.pending).toEqual(["claimed"]);
    expect(ends.length).toBe(100);
    // The claim ends the newest 100, so the three oldest sessions are leftovers.
    const acts = [
      get("/sessions", bearer(tokens[0])),
      post("/sessions/revoke-others", {}, bearer(tokens[1])),
      post("/user/delete", {}, bearer(tokens[2])),
    ];
    for (const [i, act] of acts.entries()) {
      const { res } = await measure(make(false), act);
      expect(res.status).toBe(401);
      expect(ends.slice(100).map((e) => e.reason)).toEqual(Array(i + 1).fill("claimed"));
    }
    const door = ends.slice(100).map((e) => e.id);
    expect(door.every((id) => mid.unproved.includes(id))).toBe(true);
    // The owner keeps the verified account and its proved session.
    const after = await stateOf(userId);
    expect(after.proved).toEqual(mid.proved);
    expect(after.unproved).toEqual(mid.unproved.filter((id) => !door.includes(id)));
    expect(after.pending).toEqual(["claimed"]);
    const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
      .bind(userId)
      .first<{ v: number }>();
    expect(user).toEqual({ v: 1 });
    expect((await measure(make(false), get("/session", owner))).res.status).toBe(200);
    // The sweep ends the other 17. The hook sees each claimant session once, and never the owner's.
    current = new Date(current.getTime() + 1000);
    const result = await make(true).auth.api.sweepExpired();
    expect(result.pendingSessions).toBe(17);
    expect(ends).toHaveLength(120);
    expect(new Set(ends.map((e) => e.id)).size).toBe(120);
    expect(ends.some((e) => mid.proved.includes(e.id))).toBe(false);
    expect(await stateOf(userId)).toEqual({ proved: mid.proved, unproved: [], pending: [] });
  });

  it("answers the owner's reset link over 1000 claimant sessions inside 50 queries", {
    timeout: 300_000,
  }, async () => {
    const cap = { session: { maxPerUser: 1000 } };
    const userId = await claimant("bea@example.com", 1000, cap);
    current = new Date(current.getTime() + 1000);
    expect(
      (await measure(make(false), post("/password/reset/request", { email: "bea@example.com" })))
        .res.status,
    ).toBe(200);
    const text = mail.findLast((m) => m.to === "bea@example.com")?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const reset = await measure(
      make(true, cap),
      post("/password/reset", { token, password: "another horse battery" }),
    );
    expect(reset.res.status).toBe(200);
    expect(reset.queries).toBe(PINS.reset);
    expect(ends.length).toBe(100);
    const after = await stateOf(userId);
    expect(after.proved.length).toBe(1);
    expect(after.unproved.length).toBe(900);
    expect(after.pending).toEqual(["claimed"]);
  });
});
