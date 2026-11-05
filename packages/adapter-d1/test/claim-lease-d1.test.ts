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

// The lease of a claim on D1 (ruling 16 of plan 12p). D1 does not isolate a
// transaction. So the first statement of a claim is the lease: a
// `claim-lease` verification row of the user. It lives 60 seconds
// (`CLAIM_LEASE_MS` of core). A request that runs out of queries after its
// lease cannot undo it either, so the lease stays and the next claim meets
// it. After 60 seconds a claim takes the stale lease.
//
// Every step is a real request through `auth.handle`. The request of a step
// runs on a view of the binding. The view counts each query and refuses
// query 51, as D1 Free does. The source is the D1 limits page, updated 21
// April 2026 and read 2026-10-24 (anonymous-upgrade-budget.test.ts).
//
// A flow fixes its time at its start. A claim writes the expiry of its lease
// from the clock at its write, not from that time (ruling 35 of plan 12p).
// So the owner's Google callback that waits 61 seconds in its provider call
// writes a live lease. A password sign-up in that wait keeps no password
// (ruling 26). A sweep inside a claim whose flow waited 61 seconds keeps the
// lease too, so the sign-up's lease read still finds the claim.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const SQL = Symbol("sql");
const PASSWORD = "correct horse battery";
/** `CLAIM_LEASE_MS` of core: the life of a lease. */
const LEASE_MS = 60_000;
/** The text of a lost answer, as D1 names it. */
const LOST = "D1_ERROR: Network connection lost.";
/** The lease create, the first statement of a claim on D1. The magic link writes no other verification row before it. */
const LEASE_INSERT = /^INSERT INTO ta_verification\b/;

// The counts come from the run of 2026-11-04 20:33 CST on
// <local-host> (load 1.6 3.1 5.1). The run used the D1 binding
// of this pool, with the D1 limiter on the same view. `plain` is the magic
// link that claims a password claimant with two sessions, the lease create
// included. `held` is a proof that
// meets a live lease: 409 with no claim write. `stale` is the same claim
// after it takes a stale lease. The create that meets the key (1), then the
// read of the undo and the update of the lease (2), replace the create (1).
// The `email` identity of the first request stayed, so `stale` writes no
// identity (-1). So the stale path sends two more queries than `plain`, and
// three more than a claim before plan 12p.
// Update 2026-11-05 by plan 12q: `plain` and `stale` open the owner's
// session, and its cap read adds one query (+1). `held` opens none. Measured
// 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = { plain: 28, held: 15, stale: 29 };

type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * The statement past the budget throws, as D1 Free does. `watch` runs after
 * each statement that answers.
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

/** The clock of every invocation of a test. */
let current = new Date("2026-11-04T00:00:00.000Z");
const clock = { now: () => current };
/** The mail of every invocation of a test. */
const mail: MailMessage[] = [];

/** The claims that the fake verify of an ID token answers. */
const idClaims: { current: Record<string, unknown> } = { current: {} };

/** One invocation: the engine on the counted view, or on the binding with no count. */
function make(counted: boolean, watch?: Watch, extra: Partial<AuthConfig> = {}) {
  const { db, count } = counted ? counting(env.DB, watch) : { db: env.DB, count: { queries: 0 } };
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    // An `afterEnd` hook: the claim reads its sessions and ends them by `deleteRows`.
    hooks: { session: { afterEnd: () => {} } },
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
const answer = async (res: Response) => {
  const text = await res.clone().text();
  let code = "ok";
  try {
    code = (JSON.parse(text || "{}") as { error?: string }).error ?? "ok";
  } catch {
    code = "page";
  }
  return `${res.status} ${code}`;
};

/** The claimant: a sign-up of the address and a sign-in, so the unverified user holds a password row and two sessions. */
async function claimant(email: string): Promise<string> {
  const other = make(false);
  for (const path of ["/password/sign-up", "/password/sign-in"])
    expect(
      await answer((await measure(other, post(path, { email, password: PASSWORD }))).res),
    ).toBe("200 ok");
  const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("no user");
  return user.id;
}

/** A magic link of the address, asked for with no count: the request of its verify. */
async function link(email: string): Promise<Request> {
  expect((await measure(make(false), post("/magic-link/request", { email }))).res.status).toBe(200);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  return post("/magic-link/verify", { token });
}

/** The rows of a user that a claim reads or writes, on the binding. */
async function rowsOf(userId: string) {
  const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
    .bind(userId)
    .first<{ v: number }>();
  const count = async (table: string) =>
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
        .bind(userId)
        .first<{ n: number }>()
    )?.n ?? 0;
  const lease = await env.DB.prepare(
    "SELECT purpose, identifier, expires_at AS expiresAt FROM ta_verification WHERE id = ?",
  )
    .bind(`claim-lease:${userId}`)
    .first<{ purpose: string; identifier: string; expiresAt: number | string }>();
  return {
    verified: user?.v === 1,
    passwords: await count("ta_password"),
    sessions: await count("ta_session"),
    lease: lease ? { purpose: lease.purpose, identifier: lease.identifier } : null,
  };
}

describe("the lease of a claim on D1 (ruling 16 of plan 12p)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    mail.length = 0;
    current = new Date("2026-11-04T00:00:00.000Z");
  });

  it("claims with one query more than before: the lease, which stays after the claim", async () => {
    const userId = await claimant("ada@example.com");
    const w = make(true);
    const plain = await measure(w, await link("ada@example.com"));
    expect(await answer(plain.res)).toBe("200 ok");
    expect(await rowsOf(userId)).toEqual({
      verified: true,
      passwords: 0,
      sessions: 1,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    expect(plain.queries).toBe(PINS.plain);
    expect(plain.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps the lease of a request that ran out of queries after it, answers 409 to a proof while it lives, and lets a claim take it after 60 seconds", async () => {
    const userId = await claimant("bea@example.com");
    // The first proof runs out of queries right after its lease, as a request at query 51 does.
    let capped = false;
    const first = make(true, async (sql) => {
      if (!capped && LEASE_INSERT.test(sql)) {
        capped = true;
        first.count.queries = BUDGET;
      }
    });
    const failed = await measure(first, await link("bea@example.com"));
    expect(capped).toBe(true);
    expect(failed.res.status).toBe(500);
    // Its undo ran out of queries too: the lease stays, and the claim wrote nothing else.
    expect(await rowsOf(userId)).toEqual({
      verified: false,
      passwords: 1,
      sessions: 2,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    // While the lease lives, a proof meets it: 409, and no claim write.
    const held = await measure(make(true), await link("bea@example.com"));
    expect(await answer(held.res)).toBe("409 conflict");
    expect(await rowsOf(userId)).toEqual({
      verified: false,
      passwords: 1,
      sessions: 2,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    // After 60 seconds the lease is stale, and the next claim takes it.
    current = new Date(current.getTime() + LEASE_MS + 1);
    const stale = await measure(make(true), await link("bea@example.com"));
    expect(await answer(stale.res)).toBe("200 ok");
    expect(await rowsOf(userId)).toEqual({
      verified: true,
      passwords: 0,
      sessions: 1,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    const row = await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
      .bind(`claim-lease:${userId}`)
      .first<{ e: number | string }>();
    expect(new Date(row?.e ?? 0).getTime()).toBe(current.getTime() + LEASE_MS);
    expect({ held: held.queries, stale: stale.queries }).toEqual({
      held: PINS.held,
      stale: PINS.stale,
    });
    expect(Math.max(held.queries, stale.queries)).toBeLessThanOrEqual(BUDGET);
  });

  for (const late of [LEASE_MS + 1_000, 0])
    it(`keeps no password of a sign-up beside a Google claim that waited ${late / 1000} s in its provider call`, async () => {
      const email = "cy@example.com";
      const inFetch = latch();
      const goFetch = latch();
      const atDelete = latch();
      const goDelete = latch();
      const atUser = latch();
      const goUser = latch();
      // The owner's Google account proves the address. Its token answer comes
      // late: the callback fixed its time before this call.
      const google: Partial<AuthConfig> = {
        social: {
          google: { clientId: "gid", clientSecret: "gsecret" },
          fetch: async () => {
            inFetch.open();
            await goFetch.wait;
            return Response.json({ id_token: "idtok", access_token: "at", token_type: "Bearer" });
          },
        },
        jwt: { verifyIdToken: async () => idClaims.current, signES256: async () => "es256" },
      };
      let deleted = false;
      // After the claim's delete of the passwords, before its flip.
      const owner = make(
        true,
        async (sql) => {
          if (!deleted && /^DELETE FROM ta_password\b/.test(sql)) {
            deleted = true;
            atDelete.open();
            await goDelete.wait;
          }
        },
        google,
      );
      let created = false;
      // After the sign-up's user create, before its password create.
      const signer = make(true, async (sql) => {
        if (!created && /^INSERT INTO ta_user\b/.test(sql)) {
          created = true;
          atUser.open();
          await goUser.wait;
        }
      });
      const start = await measure(
        make(false, undefined, google),
        new Request(`${BASE}/auth/social/google/start`, { headers: { origin: APP_ORIGIN } }),
      );
      const location = new URL(start.res.headers.get("location") ?? "");
      const bind = start.res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
      const iat = Math.floor(current.getTime() / 1000);
      idClaims.current = {
        iss: "https://accounts.google.com",
        aud: "gid",
        sub: "g-owner",
        email,
        email_verified: true,
        nonce: location.searchParams.get("nonce"),
        iat,
        exp: iat + 3600,
      };
      const state = location.searchParams.get("state") ?? "";
      const claim = measure(
        owner,
        new Request(`${BASE}/auth/social/google/callback?state=${state}&code=c`, {
          headers: { origin: APP_ORIGIN, cookie: bind },
        }),
      );
      await inFetch.wait;
      // The clock moves while the owner waits; the test does not sleep.
      current = new Date(current.getTime() + late);
      const signUp = measure(signer, post("/password/sign-up", { email, password: PASSWORD }));
      await atUser.wait;
      goFetch.open();
      await atDelete.wait;
      const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
        .bind(email)
        .first<{ id: string }>();
      if (!user) throw new Error("no user");
      // The claim wrote its lease from the clock at its write: live at 61 s and at 0 s.
      const lease = await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
        .bind(`claim-lease:${user.id}`)
        .first<{ e: number | string }>();
      expect(new Date(lease?.e ?? 0).getTime()).toBe(current.getTime() + LEASE_MS);
      goUser.open();
      const up = await signUp;
      goDelete.open();
      const done = await claim;
      expect(await answer(up.res)).toBe("409 email_taken_unverified");
      expect(done.res.status).toBe(302);
      expect(
        done.res.headers.getSetCookie().some((c) => /^__Host-tempo_session=[^;]/.test(c)),
      ).toBe(true);
      expect(await rowsOf(user.id)).toEqual({
        verified: true,
        passwords: 0,
        sessions: 1,
        lease: { purpose: "claim-lease", identifier: user.id },
      });
      const identities = await env.DB.prepare(
        "SELECT provider, subject FROM ta_identity WHERE user_id = ? ORDER BY provider",
      )
        .bind(user.id)
        .all<{ provider: string; subject: string }>();
      expect(identities.results).toEqual([
        { provider: "email", subject: email },
        { provider: "google", subject: "g-owner" },
      ]);
      const signIn = await measure(
        make(false),
        post("/password/sign-in", { email, password: PASSWORD }),
      );
      expect(await answer(signIn.res)).toBe("401 invalid_credentials");
      expect(Math.max(up.queries, done.queries)).toBeLessThanOrEqual(BUDGET);
    });

  it("keeps the lease through a sweep inside a claim whose flow waited 61 s, so a sign-up beside it keeps no password (ruling 35 of plan 12p)", async () => {
    const email = "dee@example.com";
    // The owner asks for the link before any user holds the address.
    const verify = await link(email);
    const inHook = latch();
    const goHook = latch();
    const atDelete = latch();
    const goDelete = latch();
    const atUser = latch();
    const goUser = latch();
    let deleted = false;
    // The owner's magic link fixes its time, then waits in user.beforeVerify,
    // as a slow hook does. After the claim's delete of the passwords, it waits
    // before its flip.
    const owner = make(
      true,
      async (sql) => {
        if (!deleted && /^DELETE FROM ta_password\b/.test(sql)) {
          deleted = true;
          atDelete.open();
          await goDelete.wait;
        }
      },
      {
        hooks: {
          session: { afterEnd: () => {} },
          user: {
            beforeVerify: async () => {
              inHook.open();
              await goHook.wait;
            },
          },
        },
      },
    );
    let created = false;
    // The claimant's sign-up waits after its user create, before its password create.
    const signer = make(true, async (sql) => {
      if (!created && /^INSERT INTO ta_user\b/.test(sql)) {
        created = true;
        atUser.open();
        await goUser.wait;
      }
    });
    const signUp = measure(signer, post("/password/sign-up", { email, password: PASSWORD }));
    await atUser.wait;
    // The claim reads the user that the sign-up created.
    const claim = measure(owner, verify);
    await inHook.wait;
    // The clock moves while the owner waits; the test does not sleep.
    current = new Date(current.getTime() + LEASE_MS + 1_000);
    goHook.open();
    await atDelete.wait;
    const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    if (!user) throw new Error("no user");
    const expiry = async () =>
      (
        await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
          .bind(`claim-lease:${user.id}`)
          .first<{ e: number | string }>()
      )?.e;
    const atLease = await expiry();
    await make(false).auth.api.sweepExpired();
    const afterSweep = await expiry();
    // The sign-up writes its password and runs its claim check, which reads the lease.
    goUser.open();
    const up = await signUp;
    goDelete.open();
    const done = await claim;
    // The answers first. After a sweep that took the lease, the sign-up would keep its password.
    expect(await answer(up.res)).toBe("409 email_taken_unverified");
    expect(await answer(done.res)).toBe("200 ok");
    expect(await rowsOf(user.id)).toEqual({
      verified: true,
      passwords: 0,
      sessions: 1,
      lease: { purpose: "claim-lease", identifier: user.id },
    });
    const signIn = await measure(
      make(false),
      post("/password/sign-in", { email, password: PASSWORD }),
    );
    expect(await answer(signIn.res)).toBe("401 invalid_credentials");
    // The claim's time is 61 s old at its lease. The expiry counts from the clock there.
    expect(new Date(atLease ?? 0).getTime()).toBe(current.getTime() + LEASE_MS);
    expect(afterSweep).toEqual(atLease);
    expect(Math.max(up.queries, done.queries)).toBeLessThanOrEqual(BUDGET);
  });
});

// A claim past the life of its lease (ruling 33 of plan 12q). D1 has no
// lock. So a claim whose statements run past 60 s can meet a rival claim.
// The rival took its lease, or a new lease after the sweep. Each delete of a
// claim before its flip runs only while the user is unverified, and the
// undo keeps that condition. The undo also needs the claim's own lease as
// it wrote it (ruling 36). So the owner keeps the rows that a rival claim
// kept, and the claimant keeps no credential and no session.
describe("a claim past the life of its lease on D1 (ruling 33 of plan 12q)", () => {
  const NEW = "the owner's new password";
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    mail.length = 0;
    current = new Date("2026-11-04T00:00:00.000Z");
  });

  /** The sessions of a user on the binding: all, and those that are proved. */
  async function sessionsOf(userId: string) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(proved), 0) AS p FROM ta_session WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ n: number; p: number }>();
    return { all: row?.n ?? 0, proved: row?.p ?? 0 };
  }

  /**
   * The identities of a user other than `email`, in order. A claim that
   * loses writes the `email` identity before its lease, and its undo
   * removes that row. The next magic link writes it again. So these tests
   * read the identities that are a way in.
   */
  async function providersOf(userId: string) {
    const rows = await env.DB.prepare(
      "SELECT provider, subject FROM ta_identity WHERE user_id = ? AND provider <> 'email' ORDER BY provider",
    )
      .bind(userId)
      .all<{ provider: string; subject: string }>();
    return rows.results.map((r) => `${r.provider}:${r.subject}`);
  }

  /** The expiry of the claim lease of a user, in ms, or null. */
  async function leaseExpiry(userId: string) {
    const row = await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
      .bind(`claim-lease:${userId}`)
      .first<{ e: number | string }>();
    return row ? new Date(row.e).getTime() : null;
  }

  /** The answer of a password sign-in of the address, with no count. */
  async function signIn(email: string, password: string) {
    return answer((await measure(make(false), post("/password/sign-in", { email, password }))).res);
  }

  /** The Google config of the owner: its token answer comes at once. */
  const google: Partial<AuthConfig> = {
    social: {
      google: { clientId: "gid", clientSecret: "gsecret" },
      fetch: async () =>
        Response.json({ id_token: "idtok", access_token: "at", token_type: "Bearer" }),
    },
    jwt: { verifyIdToken: async () => idClaims.current, signES256: async () => "es256" },
  };

  /**
   * The rival's request. The owner's Google callback with a verified
   * address keeps the identity `g-owner`. The owner's reset with the
   * password `NEW` keeps that password.
   */
  async function rivalRequest(rival: "reset" | "google", email: string): Promise<Request> {
    if (rival === "reset") {
      expect(
        (await measure(make(false), post("/password/reset/request", { email }))).res.status,
      ).toBe(200);
      const text = mail.findLast((m) => m.to === email)?.text ?? "";
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
      return post("/password/reset", { token, password: NEW });
    }
    const start = await measure(
      make(false, undefined, google),
      new Request(`${BASE}/auth/social/google/start`, { headers: { origin: APP_ORIGIN } }),
    );
    const location = new URL(start.res.headers.get("location") ?? "");
    const bind = start.res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const iat = Math.floor(current.getTime() / 1000);
    idClaims.current = {
      iss: "https://accounts.google.com",
      aud: "gid",
      sub: "g-owner",
      email,
      email_verified: true,
      nonce: location.searchParams.get("nonce"),
      iat,
      exp: iat + 3600,
    };
    const state = location.searchParams.get("state") ?? "";
    return new Request(`${BASE}/auth/social/google/callback?state=${state}&code=c`, {
      headers: { origin: APP_ORIGIN, cookie: bind },
    });
  }

  for (const form of ["stale", "sweep"] as const)
    it(`leaves the claimant no credential and no session when a rival claims past a claim's lease, by the ${form} form`, async () => {
      // The probe of open point 1 of join-task3-report.md. Claim A deletes the
      // claimant's password, and its statements then run past its lease.
      // Claim B takes the stale lease, or a new lease after the sweep, and
      // claims. A's flip matches no row. Before, A's undo put the claimant's
      // password back onto the verified user.
      const email = `zed-${form}@example.com`;
      const userId = await claimant(email);
      const first = await link(email);
      const second = await link(email);
      const atDelete = latch();
      const goDelete = latch();
      let paused = false;
      // A waits after its delete of the passwords, before its flip.
      const a = make(true, async (sql) => {
        if (!paused && /^DELETE FROM ta_password\b/.test(sql)) {
          paused = true;
          atDelete.open();
          await goDelete.wait;
        }
      });
      const claimA = measure(a, first);
      await atDelete.wait;
      expect((await rowsOf(userId)).passwords).toBe(0);
      // The clock moves past A's lease; the test does not sleep.
      current = new Date(current.getTime() + LEASE_MS + 1_000);
      if (form === "sweep") await make(false).auth.api.sweepExpired();
      const claimB = await measure(make(true), second);
      expect(await answer(claimB.res)).toBe("200 ok");
      goDelete.open();
      const doneA = await claimA;
      expect(await answer(doneA.res)).toBe("409 conflict");
      expect(await rowsOf(userId)).toEqual({
        verified: true,
        passwords: 0,
        sessions: 1,
        lease: { purpose: "claim-lease", identifier: userId },
      });
      // The one session is the owner's, from B. The claimant's two sessions are gone.
      expect(await sessionsOf(userId)).toEqual({ all: 1, proved: 1 });
      expect(await providersOf(userId)).toEqual([]);
      expect(await signIn(email, PASSWORD)).toBe("401 invalid_credentials");
      expect(Math.max(claimB.queries, doneA.queries)).toBeLessThanOrEqual(BUDGET);
    });

  for (const form of ["stale", "sweep"] as const)
    it(`puts back no row of the claimant when a claim past its lease throws between a rival's deletes and its flip, by the ${form} form`, async () => {
      // Probe R2 of rr-wave.md (ruling 36 of plan 12q). Claim A deletes the
      // claimant's password and stalls past its lease. Claim B takes the
      // stale lease, or a new lease after the sweep, and sends its deletes.
      // They find no password. A then meets a D1 error, and its undo runs
      // while the user is unverified. B then flips. Before, A's undo put the
      // password back, and B's flip kept it. Now the undo also needs A's own
      // lease as A wrote it, and B's take or the sweep changed that row.
      const email = `kim-${form}@example.com`;
      const userId = await claimant(email);
      const first = await link(email);
      const second = await link(email);
      const aStalls = latch();
      const goA = latch();
      let aPaused = false;
      // A waits after its delete of the passwords, then loses the answer of its passkey delete.
      const a = make(true, async (sql) => {
        if (!aPaused && /^DELETE FROM ta_password\b/.test(sql)) {
          aPaused = true;
          aStalls.open();
          await goA.wait;
        } else if (aPaused && /^DELETE FROM ta_passkey\b/.test(sql)) throw new Error(LOST);
      });
      const claimA = measure(a, first);
      await aStalls.wait;
      expect((await rowsOf(userId)).passwords).toBe(0);
      // The clock moves past A's lease; the test does not sleep.
      current = new Date(current.getTime() + LEASE_MS + 1_000);
      if (form === "sweep") await make(false).auth.api.sweepExpired();
      const bAtFlip = latch();
      const goB = latch();
      let bPaused = false;
      const sentB: string[] = [];
      // B waits after its passkey delete: its password delete ran and found no row.
      const b = make(true, async (sql) => {
        sentB.push(sql);
        if (!bPaused && /^DELETE FROM ta_passkey\b/.test(sql)) {
          bPaused = true;
          bAtFlip.open();
          await goB.wait;
        }
      });
      const claimB = measure(b, second);
      await bAtFlip.wait;
      expect(sentB.filter((q) => /^DELETE FROM ta_password\b/.test(q))).toHaveLength(1);
      expect(sentB.some((q) => /^UPDATE ta_user SET email_verified = \?/.test(q))).toBe(false);
      goA.open();
      const doneA = await claimA;
      expect(doneA.res.status).toBe(500);
      // A's undo ran while the user was unverified, and it put back no password.
      expect(await rowsOf(userId)).toMatchObject({ verified: false, passwords: 0 });
      goB.open();
      const doneB = await claimB;
      expect(await answer(doneB.res)).toBe("200 ok");
      expect(await rowsOf(userId)).toEqual({
        verified: true,
        passwords: 0,
        sessions: 1,
        lease: { purpose: "claim-lease", identifier: userId },
      });
      // The one session is the owner's, from B. The claimant's two sessions are gone.
      expect(await sessionsOf(userId)).toEqual({ all: 1, proved: 1 });
      expect(await providersOf(userId)).toEqual([]);
      expect(await signIn(email, PASSWORD)).toBe("401 invalid_credentials");
      expect(Math.max(doneB.queries, doneA.queries)).toBeLessThanOrEqual(BUDGET);
    });

  for (const rival of ["reset", "google"] as const)
    it(`keeps the rows that a rival claim kept when a claim's lease comes after it ended: the ${rival}`, async () => {
      // The common race, the scene of the late claim test of core. The rival
      // takes its lease, and its statements then run past the life of that
      // lease. Claim A starts in that wait and reads the user unverified,
      // before the rival's flip. The rival ends and keeps the owner's new
      // password or Google identity. A then takes the stale lease. Each
      // delete of A runs only while the user is unverified, so it deletes
      // nothing, and its flip matches no row.
      const email = `ivy-${rival}@example.com`;
      const userId = await claimant(email);
      const late = await link(email);
      const request = await rivalRequest(rival, email);
      const atDelete = latch();
      const goDelete = latch();
      let paused = false;
      // The rival waits after its first delete, the identities, so after its lease.
      const owner = make(
        true,
        async (sql) => {
          if (!paused && /^DELETE FROM ta_identity\b/.test(sql)) {
            paused = true;
            atDelete.open();
            await goDelete.wait;
          }
        },
        rival === "google" ? google : {},
      );
      const claimRival = measure(owner, request);
      await atDelete.wait;
      // The clock moves past the rival's lease; the test does not sleep.
      current = new Date(current.getTime() + LEASE_MS + 1_000);
      const inHook = latch();
      const goHook = latch();
      // A fixes its time now, reads the user unverified, and waits before its lease.
      const sent: string[] = [];
      const a = make(true, async (sql) => void sent.push(sql), {
        hooks: {
          session: { afterEnd: () => {} },
          user: {
            beforeVerify: async () => {
              inHook.open();
              await goHook.wait;
            },
          },
        },
      });
      const claimA = measure(a, late);
      await inHook.wait;
      goDelete.open();
      const won = await claimRival;
      expect(won.res.status).toBe(rival === "reset" ? 200 : 302);
      const kept = {
        passwords: rival === "reset" ? 1 : 0,
        providers: rival === "reset" ? [] : ["google:g-owner"],
      };
      expect((await rowsOf(userId)).passwords).toBe(kept.passwords);
      expect(await providersOf(userId)).toEqual(kept.providers);
      // The rival's lease is stale for A.
      expect(await leaseExpiry(userId)).toBeLessThan(current.getTime());
      goHook.open();
      // A lost claim answers 409 on D1: a flow there runs no claim retry.
      const doneA = await claimA;
      expect(await answer(doneA.res)).toBe("409 conflict");
      // A took the stale lease and sent its deletes and its flip. Its undo
      // then wrote the rival's expiry back.
      // The take is the update of the lease's expiry; the token spend sets `consumed_at`.
      const of = (re: RegExp) => sent.findIndex((q) => re.test(q));
      const take = of(/^UPDATE ta_verification SET expires_at = \?, created_at = \?/);
      const remove = of(/^DELETE FROM ta_password\b.* AND EXISTS \(/);
      expect(take).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(take);
      expect(of(/^UPDATE ta_user SET email_verified = \?/)).toBeGreaterThan(remove);
      expect(await rowsOf(userId)).toMatchObject({
        verified: true,
        passwords: kept.passwords,
        lease: { purpose: "claim-lease", identifier: userId },
      });
      expect(await providersOf(userId)).toEqual(kept.providers);
      // The rival's session lives, and it is proved. The claimant's are gone.
      expect(await sessionsOf(userId)).toEqual({ all: 1, proved: 1 });
      expect(await signIn(email, PASSWORD)).toBe("401 invalid_credentials");
      if (rival === "reset") expect(await signIn(email, NEW)).toBe("200 ok");
      expect(Math.max(won.queries, doneA.queries)).toBeLessThanOrEqual(BUDGET);
    });
});

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
