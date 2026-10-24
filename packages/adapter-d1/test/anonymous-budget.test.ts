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
const PINS = {
  signIn: 5,
  signInAgain: 3,
  refused: 2,
  delete: 9,
};
// The sweep of 101 anonymous users past their days, with no live session.
const SWEEP_PINS = { queries: 28, anonymousUsers: 100 };

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
      anonymous: {},
    });
    for (let i = 0; i < 101; i++)
      expect((await setup.handle(post("/anonymous/sign-in", {}))).status).toBe(200);
    expect(await rows("ta_user")).toBe(101);
    // Past the 30 days of anonymous.ttlDays and the 30 days of the session: no session is live.
    current = new Date(current.getTime() + 31 * DAY_MS);
    const w = make({ limiter: { allow: async () => true } });
    const swept = await w.auth.api.sweepExpired();
    const got = { queries: w.count.queries, anonymousUsers: swept.anonymousUsers };
    expect(got).toEqual(SWEEP_PINS);
    expect(got.queries).toBeLessThanOrEqual(BUDGET);
    expect(await rows("ta_user")).toBe(101 - swept.anonymousUsers);
    // The next sweep takes the rest.
    const next = make({ limiter: { allow: async () => true } });
    expect((await next.auth.api.sweepExpired()).anonymousUsers).toBe(101 - swept.anonymousUsers);
    expect(next.count.queries).toBeLessThanOrEqual(BUDGET);
    expect(await rows("ta_user")).toBe(0);
  });
});
