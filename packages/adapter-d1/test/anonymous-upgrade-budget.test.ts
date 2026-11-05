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
// Update 2026-11-04 by plan 12p: the sign-up reads the claim lease (+1), and
// the confirm's claim writes it (+1). The passkey sign-in gained its guard
// in Task 2 (+2). Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: each `done` opens a session, and its cap
// read adds one query (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = {
  signUpConfirm: { start: 13, done: 37 },
  signIn: { start: 0, done: 26 },
  magicLink: { start: 5, done: 25 },
  emailCode: { start: 8, done: 25 },
  social: { start: 4, done: 25 },
  phone: { start: 10, done: 24 },
  passkey: { start: 4, done: 27 },
  challenge: { start: 10, done: 29 },
};
// The completing request of an upgrade in a browser with a full bag
// (multiSession max 10, nine bag tokens), the join of plan 12i Tasks 7 and
// 11. The router's bag step adds one read of the rows of the browser. The
// anonymous session has ended by then, so the step reads no user and ends
// no bag session. Counts of the run of 2026-10-25.
// Update 2026-11-04 by plan 12p: the confirm's claim writes the lease (+1).
// Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: the cap read of the session (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const FULL_BAG_PINS = { signIn: 27, signUpConfirm: 38 };
// The two worst joins of final review B M of plan 12i, with every hook of
// the flows set. An ID-token sign-in that claims an unverified account with
// 1 or 10 sessions, and the sign-up confirm by code. Before the claim ended
// its sessions in one delete, each claimant session added one query (49 at
// 10 sessions). Now the count is the same for both. Counts of the run of
// 2026-10-25.
// Update 2026-11-04 by plan 12p: each claim writes the lease (+1).
// Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: the cap read of the session (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const WORST_JOIN_PINS = { idTokenClaim: 41, codeConfirm: 29, codeConfirmUniform: 40 };
/** Every hook that the two worst joins can run. */
const ALL_HOOKS: AuthConfig["hooks"] = {
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
};

/** The key that gives the SQL text of a statement under a counting view. */
const SQL = Symbol("sql");

/**
 * A step that runs after each statement of the view, with its SQL text. It
 * acts as a parallel request on the binding does between two queries.
 */
type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * Query `BUDGET + 1` throws. `watch` runs after each statement.
 */
function counting(db: D1Database, watch?: Watch) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const after = async <T>(value: Promise<T>, texts: string[]): Promise<T> => {
    const done = await value;
    for (const text of texts) await watch?.(text);
    return done;
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return after(
              (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
              [sql],
            );
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return after(
            target.batch(
              statements.map(
                (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
              ),
            ),
            statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

/**
 * Every pathway on, every upgrade hook set, on a counting view of the
 * binding. `watch` runs after each statement of the view.
 */
function make(extra: Partial<AuthConfig> = {}, counted = true, watch?: Watch) {
  // A race test runs several requests at once: one invocation each, so it counts nothing.
  const { db, count } = counted ? counting(env.DB, watch) : { db: env.DB, count: { queries: 0 } };
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

/** A browser: the cookies that the answers set, sent back on each request. */
function browser() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    jar: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") || null,
    take(res: Response): Response {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (pair.slice(eq + 1) === "") cookies.delete(pair.slice(0, eq));
        else cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res;
    },
  };
}

async function hashOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
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

  // The join of Tasks 7 and 11: the one reachable way to an anonymous
  // session with a bag. The active session of a full browser ends on
  // another device, and the browser then signs in anonymously.
  for (const name of ["signIn", "signUpConfirm"] as const)
    it(`keeps an upgrade with a full bag within the D1 Free budget: ${name}`, async () => {
      const uniform = name === "signUpConfirm";
      const w = make({
        multiSession: { max: 10 },
        ...(uniform ? { password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) } } : {}),
      });
      const b = browser();
      for (let i = 0; i < 10; i++) {
        const email = `u${i}@example.com`;
        await verifiedUser(w, email);
        const res = b.take(
          await call(w, post("/password/sign-in", { email, password: PASSWORD }, b.jar())),
        );
        expect(res.status).toBe(200);
      }
      const bag = b.cookies.get("__Host-tempo_sessions")?.split(".");
      expect(bag).toHaveLength(9);
      const active = b.cookies.get("__Host-tempo_session") ?? "";
      const other = browser();
      other.take(
        await call(w, post("/password/sign-in", { email: "u9@example.com", password: PASSWORD })),
      );
      const row = await createD1Adapter(env.DB).findOne("session", [
        { field: "tokenHash", op: "eq", value: await hashOf(active) },
      ]);
      const revoked = await call(w, post("/sessions/revoke", { id: row?.id }, other.jar()));
      expect(revoked.status).toBe(200);
      expect(b.take(await call(w, post("/anonymous/sign-in", {}, b.jar()))).status).toBe(200);
      expect(b.cookies.get("__Host-tempo_sessions")?.split(".")).toEqual(bag);
      const before = w.links.length;
      let done: Awaited<ReturnType<typeof measure>>;
      if (uniform) {
        await call(
          w,
          post("/password/sign-up", { email: "new@example.com", password: PASSWORD }, b.jar()),
        );
        const link = w.mail.findLast((m) => m.to === "new@example.com")?.text ?? "";
        done = await measure(w, post("/password/verify", { token: tokenIn(link) }, b.jar()));
      } else {
        await verifiedUser(w, "new@example.com");
        done = await measure(
          w,
          post("/password/sign-in", { email: "new@example.com", password: PASSWORD }, b.jar()),
        );
      }
      expect(b.take(done.res).status).toBe(200);
      expect(w.links.slice(before).map((l) => l.split(" ")[0])).toEqual(["before", "after"]);
      // The anonymous session took no bag place, so the bag is the same nine.
      expect(b.cookies.get("__Host-tempo_sessions")?.split(".")).toEqual(bag);
      expect(done.queries).toBe(FULL_BAG_PINS[name]);
      expect(done.queries).toBeLessThanOrEqual(BUDGET);
    });

  /** A browser with nine bag sessions whose active session ended elsewhere, then an anonymous sign-in. */
  async function fullBagAnonymous(w: World, confirm: (email: string) => Promise<void>) {
    const b = browser();
    for (let i = 0; i < 10; i++) {
      const email = `u${i}@example.com`;
      await confirm(email);
      const res = b.take(
        await call(w, post("/password/sign-in", { email, password: PASSWORD }, b.jar())),
      );
      expect(res.status).toBe(200);
    }
    expect(b.cookies.get("__Host-tempo_sessions")?.split(".")).toHaveLength(9);
    const active = b.cookies.get("__Host-tempo_session") ?? "";
    const other = browser();
    other.take(
      await call(w, post("/password/sign-in", { email: "u9@example.com", password: PASSWORD })),
    );
    const row = await createD1Adapter(env.DB).findOne("session", [
      { field: "tokenHash", op: "eq", value: await hashOf(active) },
    ]);
    expect((await call(w, post("/sessions/revoke", { id: row?.id }, other.jar()))).status).toBe(
      200,
    );
    expect(b.take(await call(w, post("/anonymous/sign-in", {}, b.jar()))).status).toBe(200);
    return b;
  }

  for (const sessions of [1, 10])
    it(`keeps an ID-token claim with a full bag and ${sessions} claimant sessions within the D1 Free budget`, async () => {
      const w = make({ multiSession: { max: 10 }, hooks: ALL_HOOKS });
      const b = await fullBagAnonymous(w, (email) => verifiedUser(w, email));
      // The claimant signs up with the address and signs in on other devices.
      const email = "bo@example.com";
      await call(w, post("/password/sign-up", { email, password: PASSWORD }));
      for (let i = 0; i < sessions; i++)
        expect(
          (await call(w, post("/password/sign-in", { email, password: PASSWORD }))).status,
        ).toBe(200);
      const nonce = (await (await call(w, post("/social/google/id-token/nonce", {}))).json()) as {
        nonce: string;
        providerNonce: string;
      };
      const iat = Math.floor(Date.now() / 1000);
      w.claims.current = {
        iss: "https://accounts.google.com",
        aud: "gid",
        sub: "g-bo",
        email,
        email_verified: true,
        nonce: nonce.providerNonce,
        iat,
        exp: iat + 3600,
      };
      const done = await measure(
        w,
        post("/social/google/id-token", { idToken: "h.e30.s", nonce: nonce.nonce }, b.jar()),
      );
      expect(b.take(done.res).status).toBe(200);
      const left = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM ta_session s JOIN ta_user u ON u.id = s.user_id WHERE u.email = ?",
      )
        .bind(email)
        .first<{ n: number }>();
      // The claim ended every claimant session; the sign-in made one.
      expect(left?.n).toBe(1);
      expect(done.queries).toBe(WORST_JOIN_PINS.idTokenClaim);
      expect(done.queries).toBeLessThanOrEqual(BUDGET);
    });

  // The count of the run of 2026-11-04 (plan 12o): the request of the race.
  // The claim ends each chunk by `deleteRows`, so the race ends one row and
  // the claim goes on in one run. On 2026-11-03 (ruling 32 of plan 12n) the
  // race answered 409 in 24 queries, and the request again took 39.
  // Update 2026-11-04 by plan 12p: the claim writes the lease (+1).
  // Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
  // Update 2026-11-05 by plan 12q: the cap read of the session (+1).
  // Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
  const RACE_PINS = { race: 41 };

  it("signs in through a session race on the worst claim join in one run, within the D1 Free budget (plan 12o)", async () => {
    // The sign-out runs on the binding with no count, as a request in another invocation.
    const other = make({}, false);
    const tokens: string[] = [];
    let live = false;
    let flipped = false;
    let outs = 0;
    const w = make({ multiSession: { max: 10 }, hooks: ALL_HOOKS }, true, async (sql) => {
      if (!live || outs > 0) return;
      // The flip of the claim, not the undo of a flip (its values are CASE forms).
      if (/^UPDATE\s+"?ta_user"?\s+SET\s+"?email_verified"?\s*=\s*\?/i.test(sql)) flipped = true;
      else if (
        flipped &&
        /^SELECT\b[\s\S]*\bFROM\s+"?ta_session"?\s+WHERE\s+"?user_id"?/i.test(sql)
      ) {
        outs++;
        // A sign-out between the claim's read of the claimant sessions and their delete.
        await other.auth.api.signOut(tokens[0] ?? "");
      }
    });
    const b = await fullBagAnonymous(w, (email) => verifiedUser(w, email));
    // The claimant signs up with the address and signs in on other devices.
    const email = "bo@example.com";
    await call(w, post("/password/sign-up", { email, password: PASSWORD }));
    for (let i = 0; i < 10; i++) {
      const res = await call(w, post("/password/sign-in", { email, password: PASSWORD }));
      expect(res.status).toBe(200);
      tokens.push(setToken(res) ?? "");
    }
    // The payload segment of the token. The route keeps a key of each used
    // payload, so the request again needs a new token from the provider.
    const idToken = async (payload: string) => {
      const nonce = (await (await call(w, post("/social/google/id-token/nonce", {}))).json()) as {
        nonce: string;
        providerNonce: string;
      };
      const iat = Math.floor(Date.now() / 1000);
      w.claims.current = {
        iss: "https://accounts.google.com",
        aud: "gid",
        sub: "g-bo",
        email,
        email_verified: true,
        nonce: nonce.providerNonce,
        iat,
        exp: iat + 3600,
      };
      return post(
        "/social/google/id-token",
        { idToken: `h.${payload}.s`, nonce: nonce.nonce },
        b.jar(),
      );
    };
    /** The rows that the claim and the upgrade write, read on the binding. */
    const state = async () => {
      const user = await env.DB.prepare(
        "SELECT id, email_verified AS v FROM ta_user WHERE email = ?",
      )
        .bind(email)
        .first<{ id: string; v: number }>();
      const ids = async (table: string) =>
        (
          await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ? ORDER BY id`)
            .bind(user?.id ?? "")
            .all<{ id: string }>()
        ).results.map((r) => r.id);
      const anonymous = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM ta_user WHERE is_anonymous = 1",
      ).first<{ n: number }>();
      return {
        verified: user?.v === 1,
        identities: await ids("ta_identity"),
        passwords: await ids("ta_password"),
        sessions: await ids("ta_session"),
        anonymous: anonymous?.n ?? 0,
      };
    };
    const before = await state();
    // The sign-up opened one session too.
    expect(before.sessions).toHaveLength(11);
    expect(before.anonymous).toBe(1);
    const gone = await createD1Adapter(env.DB).findOne("session", [
      { field: "tokenHash", op: "eq", value: await hashOf(tokens[0] ?? "") },
    ]);
    const request = await idToken("e30");
    live = true;
    const race = await measure(w, request);
    live = false;
    expect(outs).toBe(1);
    expect(b.take(race.res).status).toBe(200);
    const after = await state();
    expect(after.verified).toBe(true);
    // The claim ended each claimant session but the signed-out one; the sign-in made one.
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions.filter((id) => before.sessions.includes(id))).toEqual([]);
    expect(gone?.id).toBeDefined();
    expect(after.anonymous).toBe(0);
    expect({ race: race.queries }).toEqual(RACE_PINS);
    expect(race.queries).toBeLessThanOrEqual(BUDGET);
  });

  // The count of the run of 2026-11-03 (rr-final L-7 of plan 12n): the
  // worst claim join after one unique-key retry. A sign-up of the address
  // commits between the first run's read of the user and its user create.
  // So the create meets the unique key, and the second run claims the user
  // of the sign-up with 11 claimant sessions.
  // Update 2026-11-04 by plan 12p (ruling 16): the claim writes the lease
  // (+1), 3 under the cap. Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
  // Update 2026-11-05 by plan 12q: the cap read of the session (+1). It is 2
  // under the 50 queries of D1.
  // Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
  // `overflow` (fix round 1 of Task 2 of plan 12q): the same join with 111
  // claimant sessions. The claim ends two chunks and writes the pending-end
  // row (+1, decision 9). It is the tightest D1 pin of a session create.
  // Measured 2026-11-05 10:43 CST on the owner's Mac Studio, load 6.52 8.56 9.92.
  const UNIQUE_PINS = { retry: 48, overflow: 49 };

  /**
   * The join after one unique-key retry, with `signIns` sign-ins of the
   * claimant after its sign-up. The claimant's requests run in other
   * invocations, under a cap of `cap` sessions. Answers the count of the
   * counted request, the sessions of the claimed user, and the reasons of
   * its pending-end rows. It is an arrow function, not a declaration, so
   * `ALL_HOOKS` keeps its narrowed type in it.
   */
  const uniqueRetry = async (signIns: number, cap: number) => {
    // The sign-up and the sign-ins run on the binding with no count, as requests in other invocations.
    // Past 10 sign-ins the D1 limiter of the address refuses, so that view has an open limiter.
    // Phone and anonymous need a shared limiter, so it says that scope.
    const other =
      signIns > 10
        ? make(
            {
              session: { maxPerUser: cap },
              limiter: { scope: "shared", allow: async () => true },
            },
            false,
          )
        : make({ session: { maxPerUser: cap } }, false);
    const email = "bo@example.com";
    let live = false;
    let identityReads = 0;
    let raced = 0;
    let signedUp = "";
    const w = make(
      { multiSession: { max: 10 }, hooks: ALL_HOOKS, session: { maxPerUser: cap } },
      true,
      async (sql) => {
        if (!live) return;
        if (/^SELECT\b[\s\S]*\bFROM\s+"?ta_identity"?\s+WHERE\s+"?provider"?/i.test(sql))
          identityReads++;
        else if (
          identityReads === 1 &&
          raced === 0 &&
          /^SELECT\b[\s\S]*\bFROM\s+"?ta_user"?\s+WHERE\s+"?email"?/i.test(sql)
        ) {
          raced++;
          // The claimant signs up and signs in on other devices after the read found no user.
          await call(other, post("/password/sign-up", { email, password: PASSWORD }));
          for (let i = 0; i < signIns; i++)
            expect(
              (await call(other, post("/password/sign-in", { email, password: PASSWORD }))).status,
            ).toBe(200);
          const row = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
            .bind(email)
            .first<{ id: string }>();
          signedUp = row?.id ?? "";
        }
      },
    );
    const b = await fullBagAnonymous(w, (address) => verifiedUser(w, address));
    const nonce = (await (await call(w, post("/social/google/id-token/nonce", {}))).json()) as {
      nonce: string;
      providerNonce: string;
    };
    const iat = Math.floor(Date.now() / 1000);
    w.claims.current = {
      iss: "https://accounts.google.com",
      aud: "gid",
      sub: "g-bo",
      email,
      email_verified: true,
      nonce: nonce.providerNonce,
      iat,
      exp: iat + 3600,
    };
    live = true;
    const done = await measure(
      w,
      post("/social/google/id-token", { idToken: "h.e30.s", nonce: nonce.nonce }, b.jar()),
    );
    live = false;
    // Each run reads the identity of the provider. The claim of the second
    // run reads the email identity too, with the same SQL text.
    expect({ raced, identityReads }).toEqual({ raced: 1, identityReads: 3 });
    expect(b.take(done.res).status).toBe(200);
    const user = await env.DB.prepare("SELECT id, email_verified AS v FROM ta_user WHERE email = ?")
      .bind(email)
      .first<{ id: string; v: number }>();
    // The second run claimed the user of the sign-up: the first run's create wrote no user.
    expect(user?.id).toBe(signedUp);
    expect(user?.v).toBe(1);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(proved) AS proved FROM ta_session WHERE user_id = ?",
    )
      .bind(user?.id ?? "")
      .first<{ n: number; proved: number }>();
    const rows = await env.DB.prepare(
      "SELECT data FROM ta_verification WHERE purpose = 'session-end' AND identifier = ?",
    )
      .bind(user?.id ?? "")
      .all<{ data: string }>();
    expect(done.queries).toBeLessThanOrEqual(BUDGET);
    return {
      queries: done.queries,
      sessions: left?.n,
      proved: left?.proved,
      reasons: rows.results.map((r) => (JSON.parse(r.data) as { reason: string }).reason),
    };
  };

  it("signs in after a unique-key retry on the worst claim join within the D1 Free budget (rr-final L-7 of plan 12n)", async () => {
    // The claim ended the 11 claimant sessions; the sign-in made one.
    expect(await uniqueRetry(10, 100)).toEqual({
      queries: UNIQUE_PINS.retry,
      sessions: 1,
      proved: 1,
      reasons: [],
    });
  });

  it("signs in after a unique-key retry on the claim's overflow path within the D1 Free budget (plan 12q)", async () => {
    // 111 claimant sessions under a cap of 200. The claim ends two chunks of
    // 50 and writes a pending-end row of the reason `claimed` for the other
    // 11. The owner's proved session is the twelfth.
    expect(await uniqueRetry(110, 200)).toEqual({
      queries: UNIQUE_PINS.overflow,
      sessions: 12,
      proved: 1,
      reasons: ["claimed"],
    });
  });

  for (const uniformSignUp of [false, true])
    it(`keeps the sign-up confirm by code with a full bag within the D1 Free budget (uniformSignUp ${uniformSignUp})`, async () => {
      const hash = createPbkdf2PasswordHash({ iterations: 1000 });
      const w = make({
        multiSession: { max: 10 },
        hooks: ALL_HOOKS,
        password: { hash, uniformSignUp, verifyBy: "code" },
      });
      const codeOf = (email: string) =>
        /\b(\d{6})\b/.exec(w.mail.findLast((m) => m.to === email)?.text ?? "")?.[1];
      const b = await fullBagAnonymous(w, async (email) => {
        await call(w, post("/password/sign-up", { email, password: PASSWORD }));
        const res = await call(w, post("/password/verify/code", { email, code: codeOf(email) }));
        expect(res.status).toBe(200);
      });
      const email = "new@example.com";
      await call(w, post("/password/sign-up", { email, password: PASSWORD }, b.jar()));
      const done = await measure(
        w,
        post("/password/verify/code", { email, code: codeOf(email) }, b.jar()),
      );
      expect(b.take(done.res).status).toBe(200);
      const pin = uniformSignUp ? WORST_JOIN_PINS.codeConfirmUniform : WORST_JOIN_PINS.codeConfirm;
      expect(done.queries).toBe(pin);
      expect(done.queries).toBeLessThanOrEqual(BUDGET);
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
