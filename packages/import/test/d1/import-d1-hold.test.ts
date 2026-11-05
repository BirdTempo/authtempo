import { applyD1Migrations, env } from "cloudflare:test";
import { createD1Adapter } from "@authtempo/adapter-d1";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { BCRYPT, listSource, user } from "../source.js";

// The importer holds the claim of an unverified user for its writes on D1
// (decision 5 of plan 12q). Its hold is core's claim lease, taken before the
// first credential write and deleted before the activation. A claim that
// meets the lease answers 409 `conflict` on D1 and writes nothing. So no
// claim deletes or flips while the import writes. The lease guards only
// while it lives. So the hold reads the flag, and the import checks the
// user row after its writes. The release fails on a lease that a claim took
// (ruling 20 of plan 12q). A social identity goes in active, so the
// claimant can sign in with it after the import. That session
// is unproved, because the user is unverified, and the owner's claim ends
// it. Before plan 12q a claim could delete before the import's identity
// write and flip after it. The claimant's sign-in then got a proved session
// (open point 1 of fix round 5 of plan 12p). Each step of the owner is a
// real magic link, and each step of the claimant is a real sign-in.

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const BASE = "https://api.example.com";
/** The plaintext of BCRYPT in ../source.ts. */
const PLAIN = "allmine";
const RAW = Symbol("raw");
const SQL = Symbol("sql");
/** The flip of a claim: the statement that marks the address verified. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
const USER_INSERT = /^INSERT INTO ta_user\b/;
const IDENTITY_INSERT = /^INSERT INTO ta_identity\b/;
const PASSWORD_INSERT = /^INSERT INTO ta_password\b/;
/** The lease create of the hold: the import writes no other verification row. */
const LEASE_INSERT = /^INSERT INTO ta_verification\b/;
/** The first update of the user row by the import: the flag read of the hold. */
const USER_UPDATE = /^UPDATE ta_user\b/;
/** A write of a credential row. */
const CREDENTIAL_INSERT = /^INSERT INTO ta_(password|identity)\b/;
const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
/** `CLAIM_LEASE_MS` of core: the life of a lease. */
const LEASE_MS = 60_000;

type Gate = (sql: string) => Promise<void>;

/** A view of `db` that runs `before` before each statement and `after` after it. */
function view(db: D1Database, before?: Gate, after?: Gate): D1Database {
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return async (...args: unknown[]) => {
            await before?.(sql);
            const out = await (target[key] as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            await after?.(sql);
            return out;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const texts = statements.map((s) =>
            String((s as unknown as Record<symbol, string>)[SQL] ?? ""),
          );
          for (const t of texts) await before?.(t);
          const out = await target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
          for (const t of texts) await after?.(t);
          return out;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A view of `db` that waits at the first statement that `at` matches, after it ran. */
function pauseAfter(at: RegExp, db: D1Database = env.DB) {
  const reached = latch();
  const go = latch();
  let paused = false;
  const paused_ = view(db, undefined, async (sql) => {
    if (!paused && at.test(sql)) {
      paused = true;
      reached.open();
      await go.wait;
    }
  });
  return { db: paused_, reached: reached.wait, go: go.open, paused: () => paused };
}

/** A view of `db` that waits at the first statement that `at` matches, before it runs. */
function pauseBefore(at: RegExp, db: D1Database = env.DB) {
  const reached = latch();
  const go = latch();
  let paused = false;
  const v = view(db, async (sql) => {
    if (!paused && at.test(sql)) {
      paused = true;
      reached.open();
      await go.wait;
    }
  });
  return { db: v, reached: reached.wait, go: go.open };
}

/** A view of the binding that records the text of each statement that runs. */
function traced() {
  const texts: string[] = [];
  return { db: view(env.DB, async (sql) => void texts.push(sql)), texts };
}

/** A view that waits at the first flip of a claim, before it runs. */
function pauseBeforeFlip() {
  const reached = latch();
  const go = latch();
  let paused = false;
  const db = view(env.DB, async (sql) => {
    if (!paused && FLIP.test(sql)) {
      paused = true;
      reached.open();
      await go.wait;
    }
  });
  return { db, reached: reached.wait, go: go.open };
}

/** A view of `db` that counts each statement, and each statement of a batch. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            count.queries++;
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
          count.queries += statements.length;
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

/** A clock that a test moves ahead of the host clock; the test does not sleep. */
function movedClock() {
  let ahead = 0;
  return {
    now: () => new Date(Date.now() + ahead),
    move(ms: number) {
      ahead += ms;
    },
  };
}

/** The claims that the fake verify of a Google ID token answers. */
const idClaims: { current: Record<string, unknown> } = { current: {} };
const mail: MailMessage[] = [];
/**
 * The app on the binding, or on a view of it. It verifies bcrypt, as an app
 * that imported such hashes does, and it signs in with Google. `extra` adds
 * a clock.
 */
function app(db: D1Database = env.DB, extra: Partial<AuthConfig> = {}) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: { allow: async () => true },
    password: {
      hash: createLegacyPasswordHash({
        formats: ["bcrypt"],
        next: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
      uniformSignUp: false,
    },
    social: {
      google: { clientId: "gid", clientSecret: "gsecret" },
      fetch: async () =>
        Response.json({ id_token: "idtok", access_token: "at", token_type: "Bearer" }),
    },
    jwt: { verifyIdToken: async () => idClaims.current, signES256: async () => "es256" },
    mail: { send: async (m) => void mail.push(m) },
    ...extra,
  });
}

/** A magic link of `email`, mailed now: its token. */
async function linkOf(email: string): Promise<string> {
  expect((await app().api.requestMagicLink({ email, ip: null })).ok).toBe(true);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
}

/** The owner's magic link: "ok a session", or the error code. */
async function ownerLink(email: string, extra: Partial<AuthConfig> = {}): Promise<string> {
  const out = await app(env.DB, extra).api.verifyMagicLink({
    token: await linkOf(email),
    ip: null,
    userAgent: null,
  });
  return out.ok ? ("token" in out.value ? "ok a session" : "ok") : out.code;
}

/**
 * The claimant's Google sign-in with `subject`. The claimant's Google
 * account holds another address, so the sign-in proves no address of the
 * import.
 */
async function claimantGoogle(subject: string, email: string): Promise<string> {
  const auth = app();
  const started = await auth.api.startSocial({ provider: "google", ip: null });
  if (!started.ok) throw new Error(started.code);
  const location = new URL(started.value.location);
  const iat = Math.floor(Date.now() / 1000);
  idClaims.current = {
    iss: "https://accounts.google.com",
    aud: "gid",
    sub: subject,
    email,
    email_verified: true,
    nonce: location.searchParams.get("nonce"),
    iat,
    exp: iat + 3600,
  };
  const done = await auth.api.completeSocial({
    provider: "google",
    state: location.searchParams.get("state"),
    code: "c",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
  return done.ok ? "ok" : done.code;
}

/** The claimant's sign-in with the imported password: "ok", or the code. */
async function claimantSignIn(email: string): Promise<string | undefined> {
  const out = await app().api.password?.signIn({
    email,
    password: PLAIN,
    ip: null,
    userAgent: null,
  });
  return out?.ok ? "ok" : (out as { code?: string } | undefined)?.code;
}

async function userIdOf(email: string): Promise<string> {
  const u = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!u) throw new Error(`no user at ${email}`);
  return u.id;
}

/** The claim lease of the user of `email`, or null. */
async function leaseOf(email: string) {
  return env.DB.prepare("SELECT purpose, identifier FROM ta_verification WHERE id = ?")
    .bind(`claim-lease:${await userIdOf(email)}`)
    .first<{ purpose: string; identifier: string }>();
}

/** The expiry of the claim lease of the user of `email`, or null. */
async function leaseExpiry(email: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
    .bind(`claim-lease:${await userIdOf(email)}`)
    .first<{ e: number }>();
  return row?.e ?? null;
}

/** The rows of the user of `email` that a claim deletes or writes, and its proved sessions. */
async function rowsOf(email: string) {
  const id = await userIdOf(email);
  const u = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
    .bind(id)
    .first<{ v: number }>();
  const n = async (sql: string) =>
    (await env.DB.prepare(sql).bind(id).first<{ n: number }>())?.n ?? 0;
  const identities = await env.DB.prepare(
    "SELECT provider FROM ta_identity WHERE user_id = ? ORDER BY provider",
  )
    .bind(id)
    .all<{ provider: string }>();
  return {
    verified: u?.v,
    passwords: await n("SELECT COUNT(*) AS n FROM ta_password WHERE user_id = ?"),
    identities: identities.results.map((r) => r.provider),
    sessions: await n("SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ?"),
    proved: await n("SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ? AND proved = 1"),
  };
}

const NONE = { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 };

describe("the import of a new unverified user holds its claim on D1", () => {
  it("answers 409 to the owner's link while it writes, and the claimant's later Google session is unproved and ends at the claim", async () => {
    const email = "ari@example.com";
    // The import waits after its Google identity write.
    const run = pauseAfter(IDENTITY_INSERT);
    const report = importUsers(
      createD1Adapter(run.db),
      listSource([
        user("ari", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-ari" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    // The owner's link meets the import's lease and writes nothing.
    expect(await ownerLink(email)).toBe("conflict");
    run.go();
    const r = await report;
    expect(r.created).toEqual({ ...NONE, user: 1, identity: 1 });
    expect(r.partial).toEqual([]);
    // The import deleted its lease at its end.
    expect(await leaseOf(email)).toBeNull();
    // The claimant signs in with the imported identity: the user is unverified, so the session is unproved.
    expect(await claimantGoogle("g-ari", "ari.claimant@example.net")).toBe("ok");
    expect(await rowsOf(email)).toEqual({
      verified: 0,
      passwords: 0,
      identities: ["google"],
      sessions: 1,
      proved: 0,
    });
    // The owner's next link claims: the identity and the claimant's session go.
    expect(await ownerLink(email)).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
      proved: 1,
    });
  });

  it("signs no claimant in with a proved session when a claim deletes before the import's writes and flips after them", async () => {
    const email = "bo@example.com";
    // The import waits after its user create, so the claim reads that user.
    const run = pauseAfter(USER_INSERT);
    // Then it waits after its identity write, if it writes one.
    const written = pauseAfter(IDENTITY_INSERT, run.db);
    const report = importUsers(
      createD1Adapter(written.db),
      listSource([
        user("bo", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-bo" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    // The owner's claim takes its lease and deletes, then waits before its flip.
    const claim = pauseBeforeFlip();
    const won = app(claim.db).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    run.go();
    // The import writes its identity in that wait, or its hold refuses first and it ends.
    await Promise.race([written.reached, report]);
    claim.go();
    const owner = await won;
    expect(owner.ok && "token" in owner.value).toBe(true);
    // The claimant signs in with the Google login that the export named, after the flip.
    await claimantGoogle("g-bo", "bo.claimant@example.net");
    written.go();
    const r = await report;
    // Only the owner's session is on the account, and the import wrote no identity.
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
      proved: 1,
    });
    expect(written.paused()).toBe(false);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "bo", missing: ["identity:google"], repairRefused: "claimed" },
    ]);
    expect(r.created).toEqual(NONE);
  });
});

describe("the repair of an unverified user holds its claim on D1", () => {
  it("answers 409 to the owner's link while it writes, and the claimant's later session is unproved and ends at the claim", async () => {
    const email = "cal@example.com";
    const record = () => [user("cal", { email, emailVerified: false, password: { hash: BCRYPT } })];
    // The first run refuses the hash, so the user comes in with no password (spec 17.1).
    const first = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: [],
    });
    expect(first.refusedHashes).toHaveLength(1);
    // The repair waits after its pending password write.
    const run = pauseAfter(PASSWORD_INSERT);
    const second = importUsers(createD1Adapter(run.db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    await run.reached;
    expect(await ownerLink(email)).toBe("conflict");
    run.go();
    expect((await second).repaired).toEqual([
      { kind: "user", sourceId: "cal", rows: ["password"] },
    ]);
    expect(await leaseOf(email)).toBeNull();
    expect(await claimantSignIn(email)).toBe("ok");
    expect(await rowsOf(email)).toEqual({
      verified: 0,
      passwords: 1,
      identities: [],
      sessions: 1,
      proved: 0,
    });
    expect(await ownerLink(email)).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
      proved: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });
});

describe("a claim that runs past the life of its lease on D1", () => {
  it("keeps the repair out when the claim deletes, waits 61 s, and flips after the repair", async () => {
    const email = "eli@example.com";
    const record = () => [user("eli", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    // The owner's claim takes its lease and deletes, then waits before its flip.
    const claim = pauseBeforeFlip();
    const won = app(claim.db, { clock }).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    // The claim's lease is stale now, and the claim has not flipped.
    clock.move(LEASE_MS + 1_000);
    const second = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    claim.go();
    const owner = await won;
    expect(owner.ok && "token" in owner.value).toBe(true);
    // A hold that took the stale lease wrote the password here, and the claimant signed in proved.
    expect(second.repaired).toEqual([]);
    expect(second.partial).toEqual([
      { kind: "user", sourceId: "eli", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
      proved: 1,
    });
  });
});

/** The rows of the owner after the owner's claim: the claimant holds nothing on them. */
const OWNER_ONLY = { verified: 1, passwords: 0, identities: ["email"], sessions: 1, proved: 1 };

describe("a claim whose lease the sweep deleted before the import's hold on D1 (F1)", () => {
  it("keeps a repair of the password out: the hold reads the flag and writes nothing", async () => {
    const email = "fay@example.com";
    const record = () => [user("fay", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    // The repair read the unverified user. It waits before its first write.
    const trace = traced();
    const run = pauseBefore(WRITE, trace.db);
    const repair = importUsers(createD1Adapter(run.db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    await run.reached;
    // The owner's whole claim lands in that wait, and its lease stays.
    expect(await ownerLink(email, { clock })).toBe("ok a session");
    expect(await leaseOf(email)).not.toBeNull();
    // 61 s later the app's sweep deletes the claim's lease.
    clock.move(LEASE_MS + 1_000);
    await app(env.DB, { clock }).api.sweepExpired();
    expect(await leaseOf(email)).toBeNull();
    run.go();
    const r = await repair;
    expect(r.repaired).toEqual([]);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "fay", missing: ["password"], repairRefused: "claimed" },
    ]);
    // The flag read of the hold stops the repair before its first credential write.
    expect(trace.texts.filter((t) => CREDENTIAL_INSERT.test(t))).toEqual([]);
    expect(await leaseOf(email)).toBeNull();
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });

  it("keeps a new user's Google identity out: the hold reads the flag and writes nothing", async () => {
    const email = "gus@example.com";
    const clock = movedClock();
    // The import created the user row. It waits after that create.
    const trace = traced();
    const run = pauseAfter(USER_INSERT, trace.db);
    const report = importUsers(
      createD1Adapter(run.db),
      listSource([
        user("gus", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-gus" }],
        }),
      ]),
      { formats: ["bcrypt"], now: () => clock.now() },
    );
    await run.reached;
    expect(await ownerLink(email, { clock })).toBe("ok a session");
    clock.move(LEASE_MS + 1_000);
    await app(env.DB, { clock }).api.sweepExpired();
    expect(await leaseOf(email)).toBeNull();
    run.go();
    const r = await report;
    expect(r.created.identity).toBe(0);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "gus", missing: ["identity:google"], repairRefused: "claimed" },
    ]);
    expect(trace.texts.filter((t) => CREDENTIAL_INSERT.test(t))).toEqual([]);
    expect(await leaseOf(email)).toBeNull();
    // The claimant's Google sign-in lands on no row of the owner.
    expect(await claimantGoogle("g-gus", "gus.claimant@example.net")).toBe("ok");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });
});

describe("a claim that takes the stale lease of an import that waits 61 s after its lease create on D1 (F1b)", () => {
  it("keeps a repair of the password out, and the hold deletes no lease of the claim", async () => {
    const email = "hal@example.com";
    const record = () => [user("hal", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    const trace = traced();
    const run = pauseAfter(LEASE_INSERT, trace.db);
    const repair = importUsers(createD1Adapter(run.db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    await run.reached;
    // The import's lease is stale now. The owner's claim takes it, deletes, flips, and ends the sessions.
    clock.move(LEASE_MS + 1_000);
    expect(await ownerLink(email, { clock })).toBe("ok a session");
    const claims = await leaseExpiry(email);
    expect(claims).not.toBeNull();
    run.go();
    const r = await repair;
    expect(r.repaired).toEqual([]);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "hal", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(trace.texts.filter((t) => CREDENTIAL_INSERT.test(t))).toEqual([]);
    // The hold deleted its own lease by its expiry, so the claim's lease stays.
    expect(await leaseExpiry(email)).toBe(claims);
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });

  it("keeps a new user's Google identity out, and the hold deletes no lease of the claim", async () => {
    const email = "ivy@example.com";
    const clock = movedClock();
    const trace = traced();
    const run = pauseAfter(LEASE_INSERT, trace.db);
    const report = importUsers(
      createD1Adapter(run.db),
      listSource([
        user("ivy", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-ivy" }],
        }),
      ]),
      { formats: ["bcrypt"], now: () => clock.now() },
    );
    await run.reached;
    clock.move(LEASE_MS + 1_000);
    expect(await ownerLink(email, { clock })).toBe("ok a session");
    const claims = await leaseExpiry(email);
    expect(claims).not.toBeNull();
    run.go();
    const r = await report;
    expect(r.created.identity).toBe(0);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "ivy", missing: ["identity:google"], repairRefused: "claimed" },
    ]);
    expect(trace.texts.filter((t) => CREDENTIAL_INSERT.test(t))).toEqual([]);
    expect(await leaseExpiry(email)).toBe(claims);
    expect(await claimantGoogle("g-ivy", "ivy.claimant@example.net")).toBe("ok");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });
});

describe("the guards after the writes of a repair on D1 (ruling 20 of plan 12q)", () => {
  it("deletes its rows when a claim past the life of its lease flips inside the hold: the check of the user row", async () => {
    const email = "jon@example.com";
    const record = () => [user("jon", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    // The owner's claim takes its lease and deletes, then waits before its flip.
    const claim = pauseBeforeFlip();
    const won = app(claim.db, { clock }).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    // The claim runs past the life of its lease, and the app's sweep deletes the lease.
    clock.move(LEASE_MS + 1_000);
    await app(env.DB, { clock }).api.sweepExpired();
    expect(await leaseOf(email)).toBeNull();
    // The repair holds the user, reads the flag, and waits.
    const run = pauseAfter(USER_UPDATE);
    const repair = importUsers(createD1Adapter(run.db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    await run.reached;
    // The claim flips and ends the sessions in that wait.
    claim.go();
    const owner = await won;
    expect(owner.ok && "token" in owner.value).toBe(true);
    // The repair writes, and its check of the user row finds the flag set.
    run.go();
    const r = await repair;
    expect(r.repaired).toEqual([]);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "jon", missing: ["password"], repairRefused: "claimed" },
    ]);
    // The release deleted the lease of the hold.
    expect(await leaseOf(email)).toBeNull();
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });

  it("deletes its rows when a claim takes its stale lease, deletes before its writes, and flips after them: the release", async () => {
    const email = "kai@example.com";
    const record = () => [user("kai", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    // The repair holds the user, reads the flag, and waits past the life of its lease.
    const run = pauseAfter(USER_UPDATE);
    const repair = importUsers(createD1Adapter(run.db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    await run.reached;
    clock.move(LEASE_MS + 1_000);
    // The owner's claim takes the stale lease and deletes, then waits before its flip.
    const claim = pauseBeforeFlip();
    const won = app(claim.db, { clock }).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    const claims = await leaseExpiry(email);
    // The repair writes after the claim's delete. The flag is not set yet.
    run.go();
    const r = await repair;
    // The release matches no row, because the claim took the lease.
    expect(r.repaired).toEqual([]);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "kai", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(await leaseExpiry(email)).toBe(claims);
    claim.go();
    const owner = await won;
    expect(owner.ok && "token" in owner.value).toBe(true);
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    expect(await rowsOf(email)).toEqual(OWNER_ONLY);
  });
});

describe("a run that stops inside its hold on D1", () => {
  it("leaves its lease: a link answers 409 for 60 s, and a repair answers claimed until the sweep deletes the lease", async () => {
    const email = "dax@example.com";
    const record = () => [user("dax", { email, emailVerified: false, password: { hash: BCRYPT } })];
    const clock = movedClock();
    // The isolate dies right after the pending create, as at the D1 cap.
    // Every later statement throws, so the undo and the release fail too.
    let dead = false;
    const dying = view(
      env.DB,
      async () => {
        if (dead) throw new Error("the isolate died");
      },
      async (sql) => {
        if (PASSWORD_INSERT.test(sql)) dead = true;
      },
    );
    await expect(
      importUsers(createD1Adapter(dying), listSource(record()), {
        formats: ["bcrypt"],
        now: () => clock.now(),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(dead).toBe(true);
    const id = await userIdOf(email);
    expect(await leaseOf(email)).toEqual({ purpose: "claim-lease", identifier: id });
    // The owner's link meets the lease of the stopped run.
    expect(await ownerLink(email, { clock })).toBe("conflict");
    // A repair meets it too, and writes nothing.
    const early = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    expect(early.repaired).toEqual([]);
    expect(early.partial).toEqual([
      { kind: "user", sourceId: "dax", missing: ["password"], repairRefused: "claimed" },
    ]);
    // A sweep inside the life of the lease keeps it.
    clock.move(LEASE_MS / 2);
    await app(env.DB, { clock }).api.sweepExpired();
    expect(await leaseOf(email)).not.toBeNull();
    // After the life the lease is stale. The hold takes no stale lease, so a repair still answers claimed.
    clock.move(LEASE_MS / 2 + 1_000);
    const stale = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    expect(stale.partial).toEqual(early.partial);
    // A sweep after the life deletes it.
    await app(env.DB, { clock }).api.sweepExpired();
    expect(await leaseOf(email)).toBeNull();
    // The repair now writes the password, and the owner's link then claims.
    const repair = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    expect(repair.repaired).toEqual([{ kind: "user", sourceId: "dax", rows: ["password"] }]);
    expect(await claimantSignIn(email)).toBe("ok");
    expect(await ownerLink(email, { clock })).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
      proved: 1,
    });
  });
});

describe("the D1 queries of one record", () => {
  // Measured on 2026-11-05 on the owner's Mac Studio. Each count holds
  // the schema read of the adapter, once per run. A statement of a batch
  // counts as one query. The counts before plan 12q were 10, 9, 15, and 7.
  // An update in a D1 transaction is a batch of the undo read and the
  // write, so it counts 2. The claim check went: its update of the user row
  // (2) and its lease read (1). The lease create (1), the flag read of the
  // hold (2), the check after the writes (2), and the release (1) came in. A repair kept its own update as that check. The
  // first form of the hold, before ruling 20, sent 9, 8, 12, and 7.
  const PINS = { password: 13, google: 12, repair: 16, verified: 7 };

  it("sends the pinned count for a new unverified user with a password", async () => {
    const { db, count } = counting(env.DB);
    const r = await importUsers(
      createD1Adapter(db),
      listSource([user("ha", { emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: ["bcrypt"] },
    );
    expect(r.created.password).toBe(1);
    expect(count.queries).toBe(PINS.password);
  });

  it("sends the pinned count for a new unverified user with a Google identity", async () => {
    const { db, count } = counting(env.DB);
    const r = await importUsers(
      createD1Adapter(db),
      listSource([
        user("hc", { emailVerified: false, identities: [{ provider: "google", subject: "g-hc" }] }),
      ]),
      { formats: ["bcrypt"] },
    );
    expect(r.created.identity).toBe(1);
    expect(count.queries).toBe(PINS.google);
  });

  it("sends the pinned count for a repair of the password of an unverified user", async () => {
    const record = () => [user("hd", { emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const { db, count } = counting(env.DB);
    const r = await importUsers(createD1Adapter(db), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    expect(r.repaired).toEqual([{ kind: "user", sourceId: "hd", rows: ["password"] }]);
    expect(count.queries).toBe(PINS.repair);
  });

  it("sends the same count as before for a new verified user, which takes no hold", async () => {
    const { db, count } = counting(env.DB);
    const r = await importUsers(
      createD1Adapter(db),
      listSource([user("hb", { password: { hash: BCRYPT } })]),
      { formats: ["bcrypt"] },
    );
    expect(r.created.password).toBe(1);
    expect(count.queries).toBe(PINS.verified);
  });
});
