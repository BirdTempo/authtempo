import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of the ID-token route on the D1 binding (plan 12i Task 10).
// D1 Free allows 50 queries per invocation (D1 limits page updated 21 April
// 2026, read 2026-10-24). One request is one invocation. The limiter is the
// D1 limiter, so its queries count too. The view of the binding refuses
// query 51 as D1 Free does. Every hook that a sign-in can run is set, so
// each count is the worst case of its path.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";
// The counts of the run of 2026-10-25, with the D1 limiter. `nonce` is the
// nonce request. `create` makes a user and replaces the anonymous user of
// the request. `claim` proves the address of an unverified user, which ends
// the claimant's sessions. `challenge` answers the challenge of a user with
// the second factor on. `replay` is the refusal of a token used before.
// The claim ends the claimant's sessions in one delete since final review
// B M of plan 12i, so `claim` went from 26 to 25 (run of 2026-10-25).
// Update 2026-11-04 by plan 12p: the claim writes the lease, so `claim` went
// from 25 to 26. Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: `create` and `claim` open a session, and
// its cap read adds one query (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = { nonce: 3, create: 26, claim: 27, challenge: 9, replay: 3 };

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

/** Google with the ID-token route, the anonymous sign-in, and every hook, on a counting view. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const mail: { to: string; text: string }[] = [];
  const claims: { current: Record<string, unknown> } = { current: {} };
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    social: { google: { clientId: "gid", clientSecret: "gsecret" } },
    // The seam answers the claims of the test: the key set is not this test's subject.
    jwt: { verifyIdToken: async () => claims.current, signES256: async () => "es256" },
    anonymous: {},
    hooks: {
      anonymous: { beforeLink: () => {}, afterLink: () => {} },
      session: { beforeCreate: () => {}, afterCreate: () => {}, afterEnd: () => {} },
      user: {
        beforeCreate: () => {},
        afterCreate: () => {},
        beforeVerify: () => {},
        afterVerify: () => {},
        afterDelete: () => {},
      },
      identity: { beforeLink: () => {}, afterLink: () => {} },
    },
    ...extra,
  });
  return { auth, count, mail, claims };
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
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const call = async (w: World, request: Request) => (await measure(w, request)).res;

/** The session token that an answer set, or null. */
function setToken(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  return line?.slice("__Host-tempo_session=".length).split(";")[0] ?? null;
}

let n = 0;
/** A token text with its own payload part, so each is a new token to the used-token row. */
const tokenText = () => `h.${btoa(JSON.stringify({ n: ++n })).replace(/=+$/, "")}.s`;

/** A nonce, a Google token for `email`, and the sign-in: the measured answer. */
async function signIn(w: World, email: string, cookie: string | null = null) {
  const nr = await call(w, post("/social/google/id-token/nonce", {}));
  const { nonce, providerNonce } = (await nr.json()) as { nonce: string; providerNonce: string };
  const iat = Math.floor(Date.now() / 1000);
  w.claims.current = {
    iss: "https://accounts.google.com",
    aud: "gid",
    sub: `g-${email}`,
    email,
    email_verified: true,
    // The provider gets the SHA-256 hex of the nonce (ruling 37 I1).
    nonce: providerNonce,
    iat,
    exp: iat + 3600,
  };
  const idToken = tokenText();
  const done = await measure(w, post("/social/google/id-token", { idToken, nonce }, cookie));
  return { ...done, idToken, nonce };
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the ID-token route on D1 (plan 12i Task 10)", () => {
  it("keeps each path of the route within the D1 Free budget", async () => {
    const w = make();
    const got = { nonce: 0, create: 0, claim: 0, challenge: 0, replay: 0 };
    got.nonce = (await measure(w, post("/social/google/id-token/nonce", {}))).queries;

    // A new user, over the anonymous session of the request: the create and the upgrade.
    const anon = await call(w, post("/anonymous/sign-in", {}));
    const created = await signIn(w, "ada@example.com", `__Host-tempo_session=${setToken(anon)}`);
    expect(created.res.status).toBe(200);
    got.create = created.queries;

    // An unverified user of the address with a live session: the proof claims it.
    await call(w, post("/password/sign-up", { email: "bo@example.com", password: PASSWORD }));
    await call(w, post("/password/sign-in", { email: "bo@example.com", password: PASSWORD }));
    const claimed = await signIn(w, "bo@example.com");
    expect(claimed.res.status).toBe(200);
    got.claim = claimed.queries;

    // A user with the second factor on: the challenge in place of the session.
    const up = await call(
      w,
      post("/password/sign-up", { email: "cy@example.com", password: PASSWORD }),
    );
    const link = w.mail.findLast((m) => m.to === "cy@example.com")?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link)?.[1] ?? "");
    // The sign-up's own browser holds its proof, so the password stays (ruling 11 of plan 12q).
    const proof = up.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-tempo_signup="))
      ?.split(";")[0];
    expect((await call(w, post("/password/verify", { token }, proof ?? null))).status).toBe(200);
    const cy = await call(
      w,
      post("/password/sign-in", { email: "cy@example.com", password: PASSWORD }),
    );
    const cookie = `__Host-tempo_session=${setToken(cy)}`;
    const setup = await call(w, post("/totp/setup", { password: PASSWORD }, cookie));
    const { secret } = (await setup.json()) as { secret: string };
    const enabled = await call(
      w,
      post("/totp/enable", { code: await totpCode(base32Decode(secret), new Date()) }, cookie),
    );
    expect(enabled.status).toBe(200);
    const gated = await signIn(w, "cy@example.com");
    expect(((await gated.res.json()) as { twoFactor?: unknown }).twoFactor).toBeDefined();
    got.challenge = gated.queries;

    // The same token again, with a new nonce: the used-token row refuses it.
    const nr = await call(w, post("/social/google/id-token/nonce", {}));
    const { nonce, providerNonce } = (await nr.json()) as { nonce: string; providerNonce: string };
    w.claims.current = { ...w.claims.current, nonce: providerNonce };
    const replay = await measure(
      w,
      post("/social/google/id-token", { idToken: gated.idToken, nonce }),
    );
    expect(replay.res.status).toBe(400);
    got.replay = replay.queries;

    expect(got).toEqual(PINS);
    for (const count of Object.values(got)) expect(count).toBeLessThanOrEqual(BUDGET);
  });
});
