import { env } from "cloudflare:test";
import { type AuthConfig, createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { createRecordingSms } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each phone route on the D1 binding (plan 12i Task 5,
// ruling 20). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-24). One request is one invocation.
// The limiter is the D1 limiter, so its queries count too. The view of the
// binding refuses query 51 as D1 Free does.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const A = "+14155550100";
const B = "+14155550101";
const C = "+14155550102";
// The counts of the run of 2026-10-24, with the D1 limiter. The first
// request of the run makes one query more than a later one. So the test
// also measures a later request to a new number: it counts the same as the
// request to a known number.
const PINS = {
  requestKnown: 8,
  requestNew: 9,
  verifySignUp: 9,
  verifySignIn: 8,
  add: 11,
  addNote: 9,
  addVerify: 9,
  remove: 11,
};

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

/** The engine on a counting view of the binding, with the D1 limiter on the same view. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const sms = createRecordingSms();
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async () => {} },
    phone: { sms, regions: ["+1"], signUp: true },
    ...extra,
  });
  return { auth, count, sms };
}
type World = ReturnType<typeof make>;

/** The queries of one request, from a count of zero. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const res = await w.auth.handle(request);
  return { status: res.status, body: (await res.json()) as unknown, queries: w.count.queries };
}

let ip = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${++ip}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** The code of the last SMS: the default text starts with it. */
const lastCode = (w: World) => /^(\d+) /.exec(w.sms.sent.at(-1)?.text ?? "")?.[1] ?? "";

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the phone routes on D1 (plan 12i Task 5)", () => {
  it("keeps each phone request within the D1 Free budget", async () => {
    const w = make();
    // A sign-up by a code: the request to a new number, then the verify that makes the user.
    const requestNew = await measure(w, post("/phone/request", { phone: A }));
    expect(requestNew.body).toEqual({ sent: true });
    const verifySignUp = await measure(w, post("/phone/verify", { phone: A, code: lastCode(w) }));
    expect(verifySignUp.status).toBe(200);
    const token = (verifySignUp.body as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}` };
    // A sign-in of the known number.
    const requestKnown = await measure(w, post("/phone/request", { phone: A }));
    expect(requestKnown.body).toEqual({ sent: true });
    const verifySignIn = await measure(w, post("/phone/verify", { phone: A, code: lastCode(w) }));
    expect(verifySignIn.status).toBe(200);
    const laterNew = await measure(w, post("/phone/request", { phone: "+14155550109" }));
    expect(laterNew.body).toEqual({ sent: true });
    expect(laterNew.queries).toBe(requestKnown.queries);
    // The add of a second number, its verify, a note to a taken number, and the remove.
    const add = await measure(w, post("/phone/add", { phone: B }, bearer));
    expect(add.body).toEqual({ sent: true });
    const addVerify = await measure(w, post("/phone/add/verify", { code: lastCode(w) }, bearer));
    expect(addVerify.body).toEqual({ phone: B });
    // A second user signs up with C, and then this user asks for C: the note.
    await w.auth.handle(post("/phone/request", { phone: C }));
    await w.auth.handle(post("/phone/verify", { phone: C, code: lastCode(w) }));
    const addNote = await measure(w, post("/phone/add", { phone: C }, bearer));
    expect(addNote.body).toEqual({ sent: true });
    expect(w.sms.sent.at(-1)?.text).toContain("already in use");
    // B is the last way in of this user: the remove runs the guard and undoes the write.
    const remove = await measure(w, post("/phone/remove", {}, bearer));
    expect(remove.status).toBe(409);
    expect(remove.body).toEqual({ error: "last_credential" });
    const got = {
      requestKnown: requestKnown.queries,
      requestNew: requestNew.queries,
      verifySignUp: verifySignUp.queries,
      verifySignIn: verifySignIn.queries,
      add: add.queries,
      addNote: addNote.queries,
      addVerify: addVerify.queries,
      remove: remove.queries,
    };
    expect(got).toEqual(PINS);
    for (const q of Object.values(got)) expect(q).toBeLessThanOrEqual(BUDGET);
  });
});
