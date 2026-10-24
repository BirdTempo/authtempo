import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import {
  base32Decode,
  createRecordingSms,
  SoftAuthenticator,
  totpCode,
} from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each anonymous upgrade on the D1 binding (plan 12i Task 7).
// D1 Free allows 50 queries per invocation (D1 limits page updated 21 April
// 2026, read 2026-10-24). One request is one invocation. The limiter is the
// D1 limiter, so its queries count too. The view of the binding refuses
// query 51 as D1 Free does. Each count is of the request that completes the
// sign-in and runs the upgrade: the read of the anonymous session, the
// claim, the session end, and the delete of the anonymous user. Every hook
// that the upgrade can run is set, so each count is the worst case: an
// `afterEnd` hook makes the session end read the rows one by one.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";
const PHONE = "+14155550100";
// The counts of the run of 2026-10-25, with the D1 limiter. `start` is the
// request that records the anonymous user, `done` the one that links. The
// password sign-in has no start: it links in its own request. The confirm
// of a sign-up is the most: the claim, the session, and the upgrade.
const PINS = {
  signUpConfirm: { start: 12, done: 35 },
  signIn: { start: 0, done: 25 },
  magicLink: { start: 5, done: 24 },
  emailCode: { start: 8, done: 24 },
  social: { start: 4, done: 24 },
  phone: { start: 10, done: 23 },
  passkey: { start: 4, done: 24 },
  challenge: { start: 10, done: 28 },
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

/** Every pathway on, every upgrade hook set, on a counting view of the binding. */
function make(extra: Partial<AuthConfig> = {}, counted = true) {
  // A race test runs several requests at once: one invocation each, so it counts nothing.
  const { db, count } = counted ? counting(env.DB) : { db: env.DB, count: { queries: 0 } };
  const sms = createRecordingSms();
  const mail: { to: string; text: string }[] = [];
  const links: string[] = [];
  const claims: { current: Record<string, unknown> } = { current: {} };
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    emailOtp: {},
    phone: { sms, regions: ["+1"], signUp: true },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
    social: {
      google: { clientId: "gid", clientSecret: "gsecret" },
      fetch: async () =>
        Response.json({ id_token: "idtok", access_token: "at", token_type: "Bearer" }),
    },
    jwt: {
      verifyIdToken: async () => claims.current,
      signES256: async () => "es256",
    },
    anonymous: {},
    hooks: {
      anonymous: {
        beforeLink: (e) => void links.push(`before ${e.via}`),
        afterLink: (e) => void links.push(`after ${e.via}`),
      },
      session: { afterEnd: () => {} },
      user: { afterDelete: () => {} },
    },
    ...extra,
  });
  return { auth, count, sms, mail, links, claims };
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
const headersOf = (cookie: string | null): Record<string, string> => ({
  "content-type": "application/json",
  origin: APP_ORIGIN,
  "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
  ...(cookie ? { cookie } : {}),
});
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: headersOf(cookie),
    body: JSON.stringify(body),
  });
const get = (path: string, cookie: string | null) =>
  new Request(`${BASE}/auth${path}`, { headers: headersOf(cookie) });

/** One request with the count from zero, for a step that the test does not pin. */
const call = async (w: World, request: Request) => (await measure(w, request)).res;

/** The session token that an answer set, or null. */
function setToken(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  return line?.slice("__Host-tempo_session=".length).split(";")[0] ?? null;
}

/** An anonymous sign-in: the cookie of its browser. */
async function anonymousJar(w: World): Promise<string> {
  const res = await call(w, post("/anonymous/sign-in", {}));
  expect(res.status).toBe(200);
  return `__Host-tempo_session=${setToken(res)}`;
}

const tokenIn = (text: string) =>
  decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");

/** A verified user with a password: the sign-up and the real confirm link. */
async function verifiedUser(w: World, email: string) {
  await call(w, post("/password/sign-up", { email, password: PASSWORD }));
  const link = w.mail.findLast((m) => m.to === email)?.text ?? "";
  const res = await call(w, post("/password/verify", { token: tokenIn(link) }));
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the anonymous upgrade on D1 (plan 12i Task 7)", () => {
  it("keeps each upgrade path within the D1 Free budget", async () => {
    const got: Record<string, { start: number; done: number }> = {};
    const linked = async (
      name: string,
      w: World,
      run: (jar: string) => Promise<{ start: number; done: number }>,
    ) => {
      const jar = await anonymousJar(w);
      const before = w.links.length;
      got[name] = await run(jar);
      expect(
        w.links.slice(before).map((l) => l.split(" ")[0]),
        name,
      ).toEqual(["before", "after"]);
    };

    // The password sign-up confirm, with the uniform answer: the link carries the anonymous user.
    const uniform = make({
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    await linked("signUpConfirm", uniform, async (jar) => {
      const start = await measure(
        uniform,
        post("/password/sign-up", { email: "cy@example.com", password: PASSWORD }, jar),
      );
      const link = uniform.mail.findLast((m) => m.to === "cy@example.com")?.text ?? "";
      const done = await measure(uniform, post("/password/verify", { token: tokenIn(link) }, jar));
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    const w = make();
    await verifiedUser(w, "di@example.com");
    await linked("signIn", w, async (jar) => {
      const done = await measure(
        w,
        post("/password/sign-in", { email: "di@example.com", password: PASSWORD }, jar),
      );
      expect(done.res.status).toBe(200);
      return { start: 0, done: done.queries };
    });

    await linked("magicLink", w, async (jar) => {
      const start = await measure(w, post("/magic-link/request", { email: "ed@example.com" }, jar));
      const link = w.mail.findLast((m) => m.to === "ed@example.com")?.text ?? "";
      const done = await measure(w, post("/magic-link/verify", { token: tokenIn(link) }, jar));
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    await linked("emailCode", w, async (jar) => {
      const start = await measure(w, post("/otp/request", { email: "fy@example.com" }, jar));
      const code = /\b(\d{6})\b/.exec(
        w.mail.findLast((m) => m.to === "fy@example.com")?.text ?? "",
      )?.[1];
      const done = await measure(w, post("/otp/verify", { email: "fy@example.com", code }, jar));
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    await linked("social", w, async (jar) => {
      const start = await measure(w, get("/social/google/start", jar));
      const location = new URL(start.res.headers.get("location") ?? "");
      const bind = start.res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
      w.claims.current = {
        iss: "https://accounts.google.com",
        sub: "g-1",
        email: "gu@example.com",
        email_verified: true,
        nonce: location.searchParams.get("nonce"),
      };
      const done = await measure(
        w,
        get(
          `/social/google/callback?state=${location.searchParams.get("state")}&code=c`,
          `${bind}; ${jar}`,
        ),
      );
      expect(done.res.status).toBe(302);
      return { start: start.queries, done: done.queries };
    });

    await linked("phone", w, async (jar) => {
      const start = await measure(w, post("/phone/request", { phone: PHONE }, jar));
      const code = /^(\d+) /.exec(w.sms.sent.at(-1)?.text ?? "")?.[1];
      const done = await measure(w, post("/phone/verify", { phone: PHONE, code }, jar));
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    // A passkey of a verified user, by a real ceremony.
    await verifiedUser(w, "ha@example.com");
    const signedIn = await call(
      w,
      post("/password/sign-in", { email: "ha@example.com", password: PASSWORD }),
    );
    const own = `__Host-tempo_session=${setToken(signedIn)}`;
    const soft = await SoftAuthenticator.create({ rpID: "api.example.com", origin: BASE });
    const regOptions = await call(w, post("/passkey/register/options", {}, own));
    const reg = (await regOptions.json()) as { challenge: string; user: { id: string } };
    const added = await call(
      w,
      post(
        "/passkey/register/verify",
        { response: await soft.register(reg.challenge, new TextEncoder().encode(reg.user.id)) },
        own,
      ),
    );
    expect(added.status).toBe(200);
    await linked("passkey", w, async (jar) => {
      const start = await measure(w, post("/passkey/authenticate/options", {}, jar));
      const { challenge } = (await start.res.json()) as { challenge: string };
      const done = await measure(
        w,
        post("/passkey/authenticate/verify", { response: await soft.authenticate(challenge) }, jar),
      );
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    // A gated sign-in: the challenge carries the anonymous user, and its verify links.
    await verifiedUser(w, "io@example.com");
    const io = await call(
      w,
      post("/password/sign-in", { email: "io@example.com", password: PASSWORD }),
    );
    const ioCookie = `__Host-tempo_session=${setToken(io)}`;
    const setup = await call(w, post("/totp/setup", { password: PASSWORD }, ioCookie));
    const { secret } = (await setup.json()) as { secret: string };
    const key = base32Decode(secret);
    const enabled = await call(
      w,
      post("/totp/enable", { code: await totpCode(key, new Date()) }, ioCookie),
    );
    expect(enabled.status).toBe(200);
    await linked("challenge", w, async (jar) => {
      const start = await measure(
        w,
        post("/password/sign-in", { email: "io@example.com", password: PASSWORD }, jar),
      );
      const { twoFactor } = (await start.res.json()) as { twoFactor: { challenge: string } };
      // The next step's code: the enable spent the code of this step.
      const code = await totpCode(key, new Date(Date.now() + 30_000));
      const done = await measure(
        w,
        post("/totp/verify", { challenge: twoFactor.challenge, code }, jar),
      );
      expect(done.res.status).toBe(200);
      return { start: start.queries, done: done.queries };
    });

    expect(got).toEqual(PINS);
    for (const { start, done } of Object.values(got)) {
      expect(start).toBeLessThanOrEqual(BUDGET);
      expect(done).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("links one of parallel upgrades of one anonymous session", async () => {
    // The claim is a conditional update: on D1 the statements of the sign-ins interleave.
    const w = make({}, false);
    for (const email of ["ann@example.com", "ben@example.com", "cid@example.com"])
      await verifiedUser(w, email);
    const jar = await anonymousJar(w);
    // Not `call`: the three run at once, and the count is not read.
    const answers = await Promise.all(
      ["ann@example.com", "ben@example.com", "cid@example.com"].map((email) =>
        w.auth.handle(post("/password/sign-in", { email, password: PASSWORD }, jar)),
      ),
    );
    for (const res of answers) expect(res.status).toBe(200);
    // Each sign-in may run beforeLink; one claim wins, so afterLink runs once.
    expect(w.links.filter((l) => l.startsWith("after"))).toEqual(["after password"]);
    const anonymous = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_user WHERE is_anonymous = 1",
    ).first<{ n: number }>();
    expect(anonymous?.n).toBe(0);
  });
});
