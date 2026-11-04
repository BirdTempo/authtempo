import { applyD1Migrations, env } from "cloudflare:test";
import { createD1Adapter } from "@authtempo/adapter-d1";
import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { BCRYPT, listSource, user } from "../source.js";

// The importer beside an owner's claim on D1 (ruling 31 of plan 12p). D1
// does not isolate a transaction, so each statement of the import lands at
// once. A claim takes its lease, deletes the claimant's rows, and flips the
// flag last (ruling 16). So a claim can delete before the import's writes
// and flip after its check of the user row. The import then runs core's
// claim check, which reads the lease. The scenes come from probes I1 and I2
// of review-12p-fix34. Each step of the owner is a real magic link.

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const BASE = "https://api.example.com";
/** The plaintext of BCRYPT in ../source.ts. */
const PLAIN = "allmine";
const RAW = Symbol("raw");
const SQL = Symbol("sql");
/** The flip of a claim: the statement that marks the address verified. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
const USER_INSERT = /^INSERT INTO ta_user\b/;
const PASSWORD_INSERT = /^INSERT INTO ta_password\b/;

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

/** A view that waits at the first statement that `at` matches, after it ran. */
function pauseAfter(at: RegExp) {
  const reached = latch();
  const go = latch();
  let paused = false;
  const db = view(env.DB, undefined, async (sql) => {
    if (!paused && at.test(sql)) {
      paused = true;
      reached.open();
      await go.wait;
    }
  });
  return { db, reached: reached.wait, go: go.open };
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

const mail: MailMessage[] = [];
/** The app on the binding, or on a view of it. It verifies bcrypt, as an app that imported such hashes does. */
function app(db: D1Database = env.DB) {
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
    mail: { send: async (m) => void mail.push(m) },
  });
}

/** A magic link of `email`, mailed now: its token. */
async function linkOf(email: string): Promise<string> {
  expect((await app().api.requestMagicLink({ email, ip: null })).ok).toBe(true);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
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

/** The rows of the user of `email` that a claim deletes or writes. */
async function rowsOf(email: string) {
  const u = await env.DB.prepare("SELECT id, email_verified AS v FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string; v: number }>();
  const id = u?.id ?? "";
  const passwords = await env.DB.prepare("SELECT hash FROM ta_password WHERE user_id = ?")
    .bind(id)
    .all<{ hash: string }>();
  const identities = await env.DB.prepare(
    "SELECT provider FROM ta_identity WHERE user_id = ? ORDER BY provider",
  )
    .bind(id)
    .all<{ provider: string }>();
  const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ?")
    .bind(id)
    .first<{ n: number }>();
  return {
    verified: u?.v,
    passwords: passwords.results.length,
    identities: identities.results.map((r) => r.provider),
    sessions: sessions?.n,
  };
}

/** The owner's answer: "ok a session" when the magic link signed the owner in. */
function ownerOf(answer: Awaited<ReturnType<ReturnType<typeof app>["api"]["verifyMagicLink"]>>) {
  return answer.ok ? ("token" in answer.value ? "ok a session" : "ok") : answer.code;
}

const NONE = { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 };

describe("the import of a new unverified user beside an owner's claim on D1", () => {
  it("keeps no password when the claim reads the user, deletes, and flips after the import's check (I1)", async () => {
    const email = "ana@example.com";
    // The import waits after its user create, so the claim reads that user.
    const run = pauseAfter(USER_INSERT);
    const report = importUsers(
      createD1Adapter(run.db),
      listSource([user("ana", { email, emailVerified: false, password: { hash: BCRYPT } })]),
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
    // The import's writes and its check run in that wait.
    run.go();
    const r = await report;
    claim.go();
    expect(ownerOf(await won)).toBe("ok a session");
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "ana", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(r.created).toEqual(NONE);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });

  it("keeps no Google identity in the same scene", async () => {
    const email = "bea@example.com";
    const run = pauseAfter(USER_INSERT);
    const report = importUsers(
      createD1Adapter(run.db),
      listSource([
        user("bea", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-bea" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    const claim = pauseBeforeFlip();
    const won = app(claim.db).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    run.go();
    const r = await report;
    claim.go();
    expect(ownerOf(await won)).toBe("ok a session");
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "bea", missing: ["identity:google"], repairRefused: "claimed" },
    ]);
    expect(r.created).toEqual(NONE);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
  });

  it("keeps no password, and signs no claimant in, when the whole claim lands between the user create and the password create", async () => {
    const email = "cyd@example.com";
    const run = pauseAfter(USER_INSERT);
    // The claimant signs in right after the import's password create, before its check.
    let early: string | undefined;
    let tried = false;
    const watched = view(run.db, undefined, async (sql) => {
      if (!tried && PASSWORD_INSERT.test(sql)) {
        tried = true;
        early = await claimantSignIn(email);
      }
    });
    const report = importUsers(
      createD1Adapter(watched),
      listSource([user("cyd", { email, emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    const won = await app().api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    expect(ownerOf(won)).toBe("ok a session");
    run.go();
    const r = await report;
    expect(tried).toBe(true);
    // The row is pending until the check passed, so the user that the owner holds refuses it.
    expect(early).toBe("invalid_credentials");
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "cyd", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(r.created).toEqual(NONE);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });

  it("the control: a claim after the import deletes the imported password, which signed in before", async () => {
    const email = "dee@example.com";
    const r = await importUsers(
      createD1Adapter(env.DB),
      listSource([user("dee", { email, emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: ["bcrypt"] },
    );
    expect(r.created).toEqual({ ...NONE, user: 1, password: 1 });
    expect(r.partial).toEqual([]);
    // The password is active after the import.
    expect(await claimantSignIn(email)).toBe("ok");
    const won = await app().api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    expect(ownerOf(won)).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });
});

describe("the repair of an unverified user beside an owner's claim on D1", () => {
  it("writes nothing when the repair runs between the claim's deletes and its flip (I2)", async () => {
    const email = "eve@example.com";
    const record = () => [user("eve", { email, emailVerified: false, password: { hash: BCRYPT } })];
    // The first run refuses the hash, so the user comes in with no password (spec 17.1).
    const first = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: [],
    });
    expect(first.refusedHashes).toHaveLength(1);
    const claim = pauseBeforeFlip();
    const won = app(claim.db).api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    await claim.reached;
    // The second run accepts the format and repairs the missing password in that wait.
    const second = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    claim.go();
    expect(ownerOf(await won)).toBe("ok a session");
    expect(second.repaired).toEqual([]);
    expect(second.partial).toEqual([
      { kind: "user", sourceId: "eve", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });

  it("the control: a repair after the claim writes nothing", async () => {
    const email = "fay@example.com";
    const record = () => [user("fay", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const won = await app().api.verifyMagicLink({
      token: await linkOf(email),
      ip: null,
      userAgent: null,
    });
    expect(ownerOf(won)).toBe("ok a session");
    const second = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    expect(second.repaired).toEqual([]);
    expect(second.partial).toEqual([
      {
        kind: "user",
        sourceId: "fay",
        missing: ["password"],
        repairRefused: "verified_since_import",
      },
    ]);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });

  it("the control: a repair with no claim activates the password", async () => {
    const email = "gil@example.com";
    const record = () => [user("gil", { email, emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const second = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    expect(second.repaired).toEqual([{ kind: "user", sourceId: "gil", rows: ["password"] }]);
    expect(await claimantSignIn(email)).toBe("ok");
  });
});
