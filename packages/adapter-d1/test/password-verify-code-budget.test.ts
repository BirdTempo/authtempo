import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each request of the sign-up code on the D1 binding (plan
// 12i Task 20). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-24). One request is one invocation.
// The limiter is the D1 limiter, so its queries count too. The view of the
// binding refuses query 51 as D1 Free does. On Workers with no waitUntil,
// handle waits for the work after the answer (ruling 29 of plan 12i). So
// each count holds the code row and the mail of that work too.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";
// The counts of the run of 2026-10-25, with the D1 limiter. A known address
// does fewer queries than a new one, as in the link's sign-up of plan 12b.
// The user rows, the code row, and the mails go after the answer (rulings
// 23 and 39). So the time of the answer does not hold them. The day cap of
// ruling 39 adds one query to each sign-up and each resend. A wrong code and
// an unknown address do the same count: two limits and two reads, or two
// limits, a read, and the count.
// Update 2026-11-04 by plan 12p: the sign-up of a new address reads the
// claim lease after the answer (+1), and the confirm's claim writes it (+1).
// The queries before the answer stay the same. Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
const SIGN_UP_NEW_QUERIES = 15;
const SIGN_UP_KNOWN_QUERIES = 4;
const CONFIRM_QUERIES = 24;
const WRONG_QUERIES = 4;
const UNKNOWN_QUERIES = 4;
const RESEND_QUERIES = 8;
const RESEND_UNKNOWN_QUERIES = 4;
// At the return of handle: the two sign-up limits, the day cap, and the
// first read of the job. The job starts in the route, and the answer does
// not wait for that read.
const BEFORE_ANSWER_QUERIES = 4;

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
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), verifyBy: "code" },
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

const post = (path: string, body: unknown) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });

/** The code of the last mail to `email`: the default text starts with it. */
function lastCode(w: ReturnType<typeof make>, email: string): string {
  const text = w.mail.findLast((m) => m.to === email)?.text ?? "";
  const code = /^(\d{6}) is your /.exec(text)?.[1];
  if (code === undefined) throw new Error(`no code in the mail: ${text}`);
  return code;
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the sign-up code on D1 (plan 12i Task 20)", () => {
  it("keeps each request of the sign-up code within the D1 Free budget", async () => {
    const w = make();
    const email = "ada@example.com";
    const fresh = await measure(w, post("/password/sign-up", { email, password: PASSWORD }));
    expect(fresh.body).toEqual({ sent: true });
    const known = await measure(w, post("/password/sign-up", { email, password: PASSWORD }));
    expect(known.body).toEqual({ sent: true });
    const resend = await measure(w, post("/password/verify/resend", { email }));
    expect(resend.body).toEqual({ sent: true });
    const unknownResend = await measure(
      w,
      post("/password/verify/resend", { email: "nobody@example.com" }),
    );
    expect(unknownResend.body).toEqual({ sent: true });
    const code = lastCode(w, email);
    const wrong = await measure(
      w,
      post("/password/verify/code", { email, code: code === "000000" ? "111111" : "000000" }),
    );
    expect(wrong.body).toEqual({ error: "invalid_code" });
    const unknown = await measure(
      w,
      post("/password/verify/code", { email: "nobody@example.com", code }),
    );
    expect(unknown.body).toEqual({ error: "invalid_code" });
    const confirm = await measure(w, post("/password/verify/code", { email, code }));
    expect(confirm.status).toBe(200);
    expect(
      [fresh, known, resend, unknownResend, confirm, wrong, unknown].map((q) => q.queries),
    ).toEqual([
      SIGN_UP_NEW_QUERIES,
      SIGN_UP_KNOWN_QUERIES,
      RESEND_QUERIES,
      RESEND_UNKNOWN_QUERIES,
      CONFIRM_QUERIES,
      WRONG_QUERIES,
      UNKNOWN_QUERIES,
    ]);
    for (const q of [fresh, known, resend, unknownResend, confirm, wrong, unknown])
      expect(q.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("runs the same queries before the answer of a sign-up for a known and a new address", async () => {
    // Ruling 39 of plan 12i (M1): with a waitUntil, the user rows,
    // made.after, and the mail run after the answer. The answer of a known
    // and a new address then waits for the same queries (see
    // BEFORE_ANSWER_QUERIES). Before the ruling, a new address waited for 11
    // and a known one for 3 (review probe P2).
    const w = make();
    const after: Promise<unknown>[] = [];
    const signUp = async (email: string) => {
      w.count.queries = 0;
      const res = await w.auth.handle(post("/password/sign-up", { email, password: PASSWORD }), {
        waitUntil: (p) => void after.push(p),
      });
      const before = w.count.queries;
      expect(await res.json()).toEqual({ sent: true });
      await Promise.all(after.splice(0));
      return { before, total: w.count.queries };
    };
    const fresh = await signUp("ada@example.com");
    const known = await signUp("ada@example.com");
    expect([fresh.before, known.before]).toEqual([BEFORE_ANSWER_QUERIES, BEFORE_ANSWER_QUERIES]);
    expect([fresh.total, known.total]).toEqual([SIGN_UP_NEW_QUERIES, SIGN_UP_KNOWN_QUERIES]);
    expect(w.mail.map((m) => m.to)).toEqual(["ada@example.com", "ada@example.com"]);
  });
});
