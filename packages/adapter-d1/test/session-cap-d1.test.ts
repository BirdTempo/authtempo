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

// The cap of the sessions of one user on D1 (decision 4 of plan 12q). Before
// its insert, a session create reads the newest `session.maxPerUser` live
// sessions of the user: one query more for every create. At the cap, one
// `deleteRows` ends the oldest past it, with the reason `capped`: two
// queries more. D1 has no row lock, so two sign-ins at once can read the
// same rows and end the same oldest row. The count is then one past the
// cap, and the next sign-in ends the rest.
//
// Every step is a real request through `auth.handle` on a view of the
// binding that counts each query and refuses query 51, as D1 Free does. The
// source is the D1 limits page, updated 21 April 2026 and read 2026-10-24
// (anonymous-upgrade-budget.test.ts).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

// The counts of the run of 2026-11-05 09:27 CST on the owner's Mac Studio,
// load 23.55 17.66 14.94. `room` is a password sign-in under the cap, and
// `full` is one at the cap. Both read the D1 limiter on the same
// view. Before plan 12q a password sign-in sent 10 (a run of this file on
// the core of db9acabd, 2026-11-05). In the runs of 2026-11-05 the two
// sign-ins at once read the same rows: they ended one row between them, and
// the count was 4.
const PINS = { room: 11, full: 12 };

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

/** One invocation on the counted view, with the D1 limiter and a cap of 3. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { maxPerUser: 3 },
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
const post = (path: string, body: unknown) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });

/** The ids of the user's sessions, oldest first. */
async function sessionIds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT s.id FROM ta_session s JOIN ta_user u ON u.id = s.user_id WHERE u.email = ? ORDER BY s.id",
  )
    .bind(EMAIL)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** One password sign-in on its own counted invocation, 1 ms after the last. */
async function signIn() {
  current = new Date(current.getTime() + 1);
  const r = await measure(make(), post("/password/sign-in", { email: EMAIL, password: PASSWORD }));
  expect(r.res.status).toBe(200);
  return r.queries;
}

describe("the session cap on D1 (decision 4 of plan 12q)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    mail.length = 0;
    ends.length = 0;
    current = new Date("2026-11-05T00:00:00.000Z");
    const up = await measure(
      make(),
      post("/password/sign-up", { email: EMAIL, password: PASSWORD }),
    );
    expect(up.res.status).toBe(200);
  });

  it("reads once under the cap, and ends the oldest with the reason capped at it", async () => {
    expect(await signIn()).toBe(PINS.room);
    expect(await signIn()).toBe(PINS.room);
    const [oldest, ...rest] = await sessionIds();
    expect(rest.length).toBe(2);
    expect(await signIn()).toBe(PINS.full);
    expect(PINS.full).toBe(PINS.room + 1);
    expect(ends).toEqual([{ id: oldest, reason: "capped" }]);
    const now = await sessionIds();
    expect(now.length).toBe(3);
    expect(now.slice(0, 2)).toEqual(rest);
  });

  it("keeps the count within one of the cap for two sign-ins at once, and the next sign-in restores it", async () => {
    await signIn();
    await signIn();
    expect((await sessionIds()).length).toBe(3);
    current = new Date(current.getTime() + 1);
    const both = await Promise.all([
      measure(make(), post("/password/sign-in", { email: EMAIL, password: PASSWORD })),
      measure(make(), post("/password/sign-in", { email: EMAIL, password: PASSWORD })),
    ]);
    for (const r of both) {
      expect(r.res.status).toBe(200);
      expect(r.queries).toBeLessThanOrEqual(BUDGET);
    }
    const count = (await sessionIds()).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(4);
    expect(new Set(ends.map((e) => e.reason))).toEqual(new Set(["capped"]));
    await signIn();
    expect((await sessionIds()).length).toBe(3);
  });
});
