import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each username request on the D1 binding (plan 12i Task 2).
// D1 Free allows 50 queries per invocation (D1 limits page updated 21 April
// 2026, read 2026-10-24). One request is one invocation. The limiter is the
// D1 limiter, so its queries count too. The view of the binding refuses
// query 51 as D1 Free does.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
// The counts of the run of 2026-10-24, with the D1 limiter. The sign-up
// counts are of the detailed answer (uniformSignUp false), which opens a
// session. A sign-up with a taken name stops at the username read, before
// any read by address. The uniform sign-up takes no name (ruling 16 M1).
const SET_QUERIES = 6;
const CHECK_QUERIES = 2;
// Update 2026-11-04 by plan 12p: the sign-up reads the claim lease (+1).
// Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
const SIGN_UP_QUERIES = 15;
const TAKEN_QUERIES = 3;
// The uniform sign-up with a name stops before any read of a user (ruling 16
// M1): one query, the per-IP limit.
const UNIFORM_REFUSED_QUERIES = 1;
// Plan 12i Task 3: the password sign-in by username, run of 2026-10-24.
// A right password, an unknown name, and a wrong password.
const NAME_SIGN_IN_QUERIES = 12;
const UNKNOWN_NAME_QUERIES = 3;
const WRONG_PASSWORD_QUERIES = 4;

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
  const mail: { to: string; text: string }[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    username: {},
    ...extra,
  });
  return { auth, count, mail };
}

/** The queries of one request, from a count of zero. */
async function measure(w: ReturnType<typeof make>, request: Request) {
  w.count.queries = 0;
  const res = await w.auth.handle(request);
  return { status: res.status, body: (await res.json()) as unknown, queries: w.count.queries };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

/** A verified user with a fresh session: the sign-in of a real magic link. */
async function signedIn(w: ReturnType<typeof make>, email: string): Promise<string> {
  await w.auth.handle(post("/magic-link/request", { email }));
  const text = w.mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await w.auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.token;
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the username on D1 (plan 12i Task 2)", () => {
  it("keeps each username request within the D1 Free budget", async () => {
    const w = make();
    const bearer = { authorization: `Bearer ${await signedIn(w, "ada@example.com")}` };
    const set = await measure(w, post("/user/username", { username: "Ada" }, bearer));
    expect(set.status).toBe(200);
    const check = await measure(
      w,
      new Request(`${BASE}/auth/username/available?username=ada`, {
        headers: { "cf-connecting-ip": "198.51.100.7" },
      }),
    );
    expect(check.body).toEqual({ available: false });
    // The detailed sign-up with a free name, and with a taken one. The
    // uniform sign-up (the default) refuses a name (ruling 16 M1).
    const detailed = make({
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    });
    const up = await measure(
      detailed,
      post("/password/sign-up", {
        email: "bob@example.com",
        password: "correct horse battery",
        username: "bob",
      }),
    );
    expect(up.status).toBe(200);
    const taken = await measure(
      detailed,
      post("/password/sign-up", {
        email: "carol@example.com",
        password: "correct horse battery",
        username: "ADA",
      }),
    );
    expect(taken.body).toEqual({ error: "username_taken" });
    const uniform = await measure(
      w,
      post("/password/sign-up", {
        email: "dan@example.com",
        password: "correct horse battery",
        username: "dan",
      }),
    );
    expect(uniform.body).toEqual({ error: "invalid_body" });
    // Each is far inside 50.
    expect([set.queries, check.queries, up.queries, taken.queries, uniform.queries]).toEqual([
      SET_QUERIES,
      CHECK_QUERIES,
      SIGN_UP_QUERIES,
      TAKEN_QUERIES,
      UNIFORM_REFUSED_QUERIES,
    ]);
    for (const q of [set, check, up, taken, uniform]) expect(q.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps each sign-in by username within the D1 Free budget", async () => {
    const w = make();
    // A real user: the uniform sign-up, the verify link of the mail, then
    // the set of the name with the session of the link. The uniform sign-up
    // takes no name (ruling 16 M1).
    const up = await w.auth.handle(
      post("/password/sign-up", { email: "ada@example.com", password: "correct horse battery" }),
    );
    expect(await up.json()).toEqual({ sent: true });
    const text = w.mail.findLast((m) => m.to === "ada@example.com")?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const verified = await w.auth.api.password?.verifyEmail({ token, ip: null, userAgent: null });
    if (!verified?.ok || !verified.value.signedIn) throw new Error("no session");
    const bearer = { authorization: `Bearer ${verified.value.signedIn.token}` };
    expect((await w.auth.handle(post("/user/username", { username: "Ada" }, bearer))).status).toBe(
      200,
    );
    const signIn = (username: string, password: string) =>
      measure(w, post("/password/sign-in", { username, password }));
    const right = await signIn("ADA", "correct horse battery");
    expect(right.status).toBe(200);
    const unknown = await signIn("nobody", "correct horse battery");
    const wrong = await signIn("ada", "a wrong horse battery");
    expect(unknown.body).toEqual({ error: "invalid_credentials" });
    expect(wrong.body).toEqual(unknown.body);
    expect([right.queries, unknown.queries, wrong.queries]).toEqual([
      NAME_SIGN_IN_QUERIES,
      UNKNOWN_NAME_QUERIES,
      WRONG_PASSWORD_QUERIES,
    ]);
    for (const q of [right, unknown, wrong]) expect(q.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("lets the unique key decide a race of two sets of one name", async () => {
    const w = make();
    const a = { authorization: `Bearer ${await signedIn(w, "ada@example.com")}` };
    const b = { authorization: `Bearer ${await signedIn(w, "bob@example.com")}` };
    const answers = await Promise.all([
      w.auth.handle(post("/user/username", { username: "same" }, a)),
      w.auth.handle(post("/user/username", { username: "Same" }, b)),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.json()));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(bodies).toContainEqual({ error: "username_taken" });
    const rows = await env.DB.prepare(
      "SELECT username FROM ta_user WHERE username IS NOT NULL",
    ).all();
    expect(rows.results).toEqual([{ username: "same" }]);
  });
});
