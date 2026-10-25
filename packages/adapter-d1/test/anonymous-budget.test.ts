import { env } from "cloudflare:test";
import { type AuthConfig, createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of the anonymous routes and of the anonymous step of the
// sweep on the D1 binding (plan 12i Task 6, the lane ruling). D1 Free
// allows 50 queries per invocation (D1 limits page updated 21 April 2026,
// read 2026-10-24). One request is one invocation, and so is one sweep. The
// limiter of a route is the D1 limiter, so its queries count too. The view
// of the binding refuses query 51 as D1 Free does.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW = Symbol("raw");
// The counts of the run of 2026-10-24, with the D1 limiter. `refused` is a
// route of ANONYMOUS_REFUSED: the router step reads the session and the
// user, and answers before the handler.
// The sign-in counts the daily cap of the deployment too (ruling 25 M4).
const PINS = {
  signIn: 6,
  signInAgain: 3,
  refused: 2,
  delete: 9,
};
// The sweep of 101 anonymous users past their days, with no live session.
const SWEEP_PINS = { queries: 28, anonymousUsers: 100 };
// The rows that one read of the anonymous step may take on D1. That is an
// index entry and a row for each of the 50 users of a page (ANONYMOUS_PAGE).
// It adds the one index entry that ends the range. The run of 2026-10-25
// read 101.
const PAGE_ROWS = 2 * 50 + 1;
// The sweep of 60 anonymous users past their days behind a backlog of 300
// client links (ruling 25 M2), on the run of 2026-10-24. With no share of
// its own, the step gets one page, 50 users, after the link and outbox steps.
const SHARE_PINS = { oauthSessionLinks: 10, oauthLogouts: 4, anonymousUsers: 60, queries: 48 };

/** A view of `db` that counts each statement, and each statement of a batch. Query `BUDGET + 1` throws. */
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
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
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

/** A view of `db` that keeps the SQL and `meta.rows_read` of each statement that it runs. */
function reading(db: D1Database) {
  const log: { sql: string; rows: number }[] = [];
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "all" || key === "run")
          return async () => {
            const r = await target[key]();
            log.push({ sql, rows: r.meta.rows_read });
            return r;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const view = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const raws = statements.map(
            (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
          );
          const results = await target.batch(raws);
          for (const r of results) log.push({ sql: "(batch)", rows: r.meta.rows_read });
          return results;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: view as D1Database, log };
}

// A limiter that allows each call, for the setup and the sweeps. It counts
// nothing, so the anonymous config allows it as an isolate limiter.
const OPEN: Partial<AuthConfig> = {
  limiter: { allow: async () => true },
  anonymous: { isolateLimiter: "allow" },
};

let current = new Date("2026-10-24T00:00:00.000Z");
const clock = { now: () => current };

/** The engine on a counting view of the binding. Each call is a new invocation. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async () => {} },
    clock,
    anonymous: {},
    ...extra,
  });
  return { auth, count };
}
type World = ReturnType<typeof make>;

/** The queries of one request, from a count of zero. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const res = await w.auth.handle(request);
  return { res, status: res.status, queries: w.count.queries };
}

let ip = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${++ip % 250}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** The session token of an answer that set the session cookie. */
function cookieOf(res: Response): string {
  const line = res.headers.getSetCookie().find((s) => s.startsWith("__Host-tempo_session="));
  const token = line?.slice("__Host-tempo_session=".length).split(";")[0];
  if (!token) throw new Error("the answer set no session cookie");
  return `__Host-tempo_session=${token}`;
}

const rows = async (table: string) =>
  Number(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"));

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  current = new Date("2026-10-24T00:00:00.000Z");
});

describe("the anonymous routes on D1 (plan 12i Task 6)", () => {
  it("keeps each anonymous request within the D1 Free budget", async () => {
    const w = make();
    const signIn = await measure(w, post("/anonymous/sign-in", {}));
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn.res);
    const signInAgain = await measure(w, post("/anonymous/sign-in", {}, { cookie }));
    expect(signInAgain.status).toBe(200);
    const refused = await measure(w, post("/tokens", { name: "ci" }, { cookie }));
    expect(refused.status).toBe(403);
    expect(await refused.res.json()).toEqual({ error: "anonymous_refused" });
    const deleted = await measure(w, post("/anonymous/delete", {}, { cookie }));
    expect(deleted.status).toBe(200);
    expect(await rows("ta_user")).toBe(0);
    expect(await rows("ta_session")).toBe(0);
    const got = {
      signIn: signIn.queries,
      signInAgain: signInAgain.queries,
      refused: refused.queries,
      delete: deleted.queries,
    };
    expect(got).toEqual(PINS);
    for (const q of Object.values(got)) expect(q).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps the anonymous step of the sweep within its share of the D1 Free budget", async () => {
    // The sign-ins of the setup run on the binding itself: many invocations, not one.
    const setup = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createD1Adapter(env.DB),
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock,
      anonymous: { isolateLimiter: "allow" },
    });
    for (let i = 0; i < 101; i++)
      expect((await setup.handle(post("/anonymous/sign-in", {}))).status).toBe(200);
    expect(await rows("ta_user")).toBe(101);
    // Past the 30 days of anonymous.ttlDays and the 30 days of the session: no session is live.
    current = new Date(current.getTime() + 31 * DAY_MS);
    const w = make(OPEN);
    const swept = await w.auth.api.sweepExpired();
    const got = { queries: w.count.queries, anonymousUsers: swept.anonymousUsers };
    expect(got).toEqual(SWEEP_PINS);
    expect(got.queries).toBeLessThanOrEqual(BUDGET);
    expect(await rows("ta_user")).toBe(101 - swept.anonymousUsers);
    // The next sweep takes the rest.
    const next = make(OPEN);
    expect((await next.auth.api.sweepExpired()).anonymousUsers).toBe(101 - swept.anonymousUsers);
    expect(next.count.queries).toBeLessThanOrEqual(BUDGET);
    expect(await rows("ta_user")).toBe(0);
  });
});

describe("the anonymous step on a large user table (plan 12i Task 6, ruling 25)", () => {
  /** `count` users with a verified address, made before `at`, one per second. */
  async function seedAddressUsers(count: number, at: number) {
    const insert = env.DB.prepare(
      "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)",
    );
    const rows = [];
    for (let i = 0; i < count; i++) {
      const made = at - (count - i) * 1000;
      rows.push(insert.bind(`01K${String(i).padStart(23, "0")}`, made, made, `u${i}@example.com`));
    }
    for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
  }

  /**
   * `count` anonymous users made by the route, one per second from the clock
   * time. The index has no `id`, so SQLite sorts the users of one `createdAt`
   * by id in a temp tree: a read takes each user of the last time it reaches.
   * Users of one millisecond are rare, so the seed gives each its own second.
   */
  async function signIns(count: number) {
    const setup = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createD1Adapter(env.DB),
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock,
      anonymous: { isolateLimiter: "allow" },
    });
    for (let i = 0; i < count; i++) {
      expect((await setup.handle(post("/anonymous/sign-in", {}))).status).toBe(200);
      current = new Date(current.getTime() + 1000);
    }
  }

  it("reads the old anonymous users alone through the index on (is_anonymous, created_at)", async () => {
    // 10 000 users with an address, 120 anonymous users past their days, and 300 young ones.
    await seedAddressUsers(10_000, current.getTime() - 40 * DAY_MS);
    await signIns(120);
    current = new Date(current.getTime() + 31 * DAY_MS);
    await signIns(300);
    expect(await rows("ta_user")).toBe(10_420);
    const { db, log } = reading(env.DB);
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createD1Adapter(db),
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock,
      anonymous: { isolateLimiter: "allow" },
    });
    expect((await auth.api.sweepExpired()).anonymousUsers).toBe(100);
    const steps = log.filter((l) => /FROM ta_user WHERE is_anonymous = /.test(l.sql));
    expect(steps).toHaveLength(2);
    // Each read takes one page: an index entry and a row for each user, and one entry
    // more that ends the range. A scan would read 10 420 rows. A sort by
    // `created_at IS NULL` first would read each old anonymous user (ruling 27).
    for (const step of steps) expect(step.rows).toBeLessThanOrEqual(PAGE_ROWS);
    const [first] = steps;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${first?.sql}`)
      .bind(1, 0, 50)
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join("; ");
    expect(detail).toContain("USING INDEX ix_ta_user__is_anonymous__created_at");
    // The index gives the created_at order: only the id term of one time needs a sort.
    expect(detail).not.toContain("TEMP B-TREE FOR ORDER BY");
    // The next sweep takes the other 20, and then an idle sweep reads no young user.
    expect((await auth.api.sweepExpired()).anonymousUsers).toBe(20);
    log.length = 0;
    expect((await auth.api.sweepExpired()).anonymousUsers).toBe(0);
    const idle = log.filter((l) => /FROM ta_user WHERE is_anonymous = /.test(l.sql));
    expect(idle.map((l) => l.rows)).toEqual([expect.any(Number)]);
    expect(idle[0]?.rows).toBeLessThanOrEqual(2);
  }, 120_000);

  it("reads one page per read with a backlog of 2 000 old anonymous users (ruling 27)", async () => {
    // A backlog after an outage: every run must cost a page, not the backlog.
    await seedAddressUsers(1_000, current.getTime() - 40 * DAY_MS);
    await signIns(2_000);
    current = new Date(current.getTime() + 31 * DAY_MS);
    const { db, log } = reading(env.DB);
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createD1Adapter(db),
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock,
      anonymous: { isolateLimiter: "allow" },
    });
    expect((await auth.api.sweepExpired()).anonymousUsers).toBe(100);
    // Two pages, and each reads one page of the backlog, not the 2 000 users. With the
    // `IS NULL` term each read took the whole backlog that stayed: 4 000 and 3 900 rows.
    const steps = log.filter((l) => /FROM ta_user WHERE is_anonymous = /.test(l.sql));
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.rows).toBeLessThanOrEqual(PAGE_ROWS);
    expect(await rows("ta_user")).toBe(1_000 + 2_000 - 100);
  }, 120_000);

  it("keeps its share when a link backlog fills the steps before it", async () => {
    // A user whose sessions expired and went at a sweep, with 300 client links left. The
    // client went too, as an idle client does (sweepClients deletes no link). The link step
    // makes each link an outbox row, and the outbox step takes the calls that stay.
    await seedAddressUsers(1, current.getTime());
    const t = current.getTime();
    const links = env.DB.prepare(
      "INSERT INTO ta_oauth_session_client (id, created_at, updated_at, session_id, client_id, user_id, sid) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const batch = [];
    // 30 clients, so the outbox cap of 10 rows of one client does not end the outbox step.
    for (let i = 0; i < 300; i++)
      batch.push(
        links.bind(`lk${i}`, t, t, `s${i}`, `cl_gone${i % 30}`, `01K${"0".repeat(23)}`, `sid${i}`),
      );
    await env.DB.batch(batch);
    await signIns(60);
    current = new Date(current.getTime() + 31 * DAY_MS);
    const w = make(OPEN);
    const swept = await w.auth.api.sweepExpired();
    const got = {
      oauthSessionLinks: swept.oauthSessionLinks,
      oauthLogouts: swept.oauthLogouts,
      anonymousUsers: swept.anonymousUsers,
      queries: w.count.queries,
    };
    expect(got).toEqual(SHARE_PINS);
    expect(got.queries).toBeLessThanOrEqual(BUDGET);
  });
});
