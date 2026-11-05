import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { base32Decode, createRecordingSms, totpCode } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each phone route on the D1 binding (plan 12i Task 5,
// ruling 20). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-24). One request is one invocation.
// The limiter is the D1 limiter, so its queries count too. The view of the
// binding refuses query 51 as D1 Free does. The send of a phone request
// runs after the answer under waitUntil (ruling 23 of plan 12i). That work
// runs in the same invocation, so each count holds the answer and that work.

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
// Update 2026-11-05 by plan 12q: each verify opens a session, and its cap
// read adds one query (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = {
  requestKnown: 8,
  requestNew: 9,
  verifySignUp: 10,
  verifySignIn: 9,
  // The Task 5 fix round: the add counts one key per number, not two. The
  // note writes a decoy row of 3 queries (ruling 23, m1 and L5). The one
  // query between the add and the note is outside the phone work, as before.
  add: 10,
  addNote: 11,
  addVerify: 9,
  remove: 11,
};
// The Task 5 fix round (ruling 23, L4), run of 2026-10-24. The answer of a
// request with signUp off to an unknown number does no work after the
// answer. A known number runs the same answer path, and the send after it.
const AFTER_PINS = {
  requestAnswer: 5,
  requestKnown: 8,
  requestAfter: 3,
  verifyChallenge: 8,
  removeCommits: 10,
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

/**
 * The queries of one request, from a count of zero. The count waits for the
 * work after the answer (ruling 23 of plan 12i): one invocation runs both.
 */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  const body = (await res.json()) as unknown;
  await Promise.all(after);
  return { status: res.status, body, queries: w.count.queries };
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
    await measure(w, post("/phone/request", { phone: C }));
    await measure(w, post("/phone/verify", { phone: C, code: lastCode(w) }));
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

  it("keeps the answer path, the work after it, the challenge, and a committed remove in the budget", async () => {
    const password = "correct horse battery";
    const mail: string[] = [];
    const w = make({
      mail: { send: async (m) => void mail.push(m.text) },
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    });
    // A verified user with a password, a fresh session, and the second factor.
    const api = w.auth.api;
    const up = await api.password?.signUp({
      email: "ada@example.com",
      password,
      ip: null,
      userAgent: null,
    });
    if (!up?.ok) throw new Error("no sign-up");
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
    const v = await api.password?.verifyEmail({ token, ip: null, userAgent: null });
    if (!v?.ok || v.value.signedIn === null) throw new Error("the verify link did not sign in");
    const bearer = { authorization: `Bearer ${v.value.signedIn.token}` };
    // The phone comes from a real code (ruling 20), before the factor is on.
    expect((await measure(w, post("/phone/add", { phone: A }, bearer))).body).toEqual({
      sent: true,
    });
    const set = await measure(w, post("/phone/add/verify", { code: lastCode(w) }, bearer));
    expect(set.body).toEqual({ phone: A });
    const session = await api.getSession(v.value.signedIn.token);
    if (!session || !api.totp) throw new Error("no session or no totp");
    const setup = await api.totp.setup({ session, password });
    if (!setup.ok) throw new Error(setup.code);
    const on = await api.totp.enable({
      session,
      code: await totpCode(base32Decode(setup.value.secret), new Date()),
    });
    if (!on.ok) throw new Error(on.code);
    // With signUp off, an unknown number answers with no work after the answer.
    const closed = make({
      phone: { sms: w.sms, regions: ["+1"], signUp: false },
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    const requestAnswer = await measure(closed, post("/phone/request", { phone: B }));
    expect(requestAnswer.body).toEqual({ sent: true });
    expect(w.sms.sent.at(-1)?.to).toBe(A);
    const requestKnown = await measure(closed, post("/phone/request", { phone: A }));
    expect(requestKnown.body).toEqual({ sent: true });
    expect(w.sms.sent.at(-1)?.to).toBe(A);
    // The gate of the factor: the challenge, and no session.
    const challenge = await measure(closed, post("/phone/verify", { phone: A, code: lastCode(w) }));
    expect(challenge.body).toMatchObject({ twoFactor: { methods: ["totp", "backup"] } });
    // The address and the password stay: the remove commits.
    const removed = await measure(w, post("/phone/remove", {}, bearer));
    expect(removed.body).toEqual({ ok: true });
    const got = {
      requestAnswer: requestAnswer.queries,
      requestKnown: requestKnown.queries,
      requestAfter: requestKnown.queries - requestAnswer.queries,
      verifyChallenge: challenge.queries,
      removeCommits: removed.queries,
    };
    expect(got).toEqual(AFTER_PINS);
    for (const q of Object.values(got)) expect(q).toBeLessThanOrEqual(BUDGET);
  });
});
