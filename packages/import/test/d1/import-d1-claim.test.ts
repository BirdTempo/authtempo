import { applyD1Migrations, env } from "cloudflare:test";
import { createD1Adapter } from "@authtempo/adapter-d1";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  PENDING_HASH_PREFIX,
} from "@authtempo/core";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { verifyReport } from "../../src/report.js";
import { BCRYPT, listSource, user } from "../source.js";

// The importer beside an owner's claim on D1 (ruling 31 of plan 12p). D1
// does not isolate a transaction, so each statement of the import lands at
// once. A claim takes its lease, deletes the claimant's rows, and flips the
// flag last (ruling 16). So a claim could delete before the import's writes
// and flip after its check of the user row. Since plan 12q the import holds
// the lease of the user for its writes (decision 5). So it meets the lease
// of such a claim and writes nothing. The scenes come from probes I1 and I2 of
// review-12p-fix34, and S1 of review-12p-fix5w. Each step of the owner is a
// real magic link. The last scene is a run that stops after its pending
// password create, from probe K of review-12p-fix5w. The scenes of the hold
// itself are in import-d1-hold.test.ts.

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
/**
 * The app on the binding, or on a view of it. It verifies bcrypt, as an app
 * that imported such hashes does. `extra` adds a clock or hooks.
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
    mail: { send: async (m) => void mail.push(m) },
    ...extra,
  });
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
  it("keeps no password when the claim reads the user, deletes, and flips after the import's hold (I1)", async () => {
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
    // The import's hold runs in that wait. It meets the claim's lease, so the import writes nothing more.
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

  it("keeps no password, and signs no claimant in, when the whole claim lands between the user create and the import's hold", async () => {
    const email = "cyd@example.com";
    const run = pauseAfter(USER_INSERT);
    // The claimant would sign in right after an import's password create.
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
    // The hold met the claim's lease before any password create (plan 12q).
    expect(tried).toBe(false);
    expect(early).toBeUndefined();
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

  it("writes nothing when a sweep runs inside a claim whose flow waited 61 s, between its deletes and its flip (S1)", async () => {
    const email = "hal@example.com";
    const record = () => [user("hal", { email, emailVerified: false, password: { hash: BCRYPT } })];
    // The first run refuses the hash, so the user comes in with no password (spec 17.1).
    await importUsers(createD1Adapter(env.DB), listSource(record()), { formats: [] });
    const clock = movedClock();
    const inHook = latch();
    const goHook = latch();
    // The owner's magic link fixes its time, then waits in user.beforeVerify,
    // as a slow hook does. It takes its lease and deletes, then waits before its flip.
    const claim = pauseBeforeFlip();
    const won = app(claim.db, {
      clock,
      hooks: {
        user: {
          beforeVerify: async () => {
            inHook.open();
            await goHook.wait;
          },
        },
      },
    }).api.verifyMagicLink({ token: await linkOf(email), ip: null, userAgent: null });
    await inHook.wait;
    clock.move(61_000);
    goHook.open();
    await claim.reached;
    const found = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    // The tests of this file share the binding, so the read names this user's lease.
    const lease = () =>
      env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
        .bind(`claim-lease:${found?.id ?? ""}`)
        .all<{ e: number | string }>();
    const atLease = (await lease()).results;
    // The sweep runs at the moved time.
    const swept = clock.now().getTime();
    await app(env.DB, { clock }).api.sweepExpired();
    const afterSweep = (await lease()).results;
    // The second run accepts the format and repairs the missing password in that wait.
    const second = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
      now: () => clock.now(),
    });
    claim.go();
    // The answers first. After a sweep that took the lease, the repair would keep its password.
    expect(ownerOf(await won)).toBe("ok a session");
    expect(second.repaired).toEqual([]);
    expect(second.partial).toEqual([
      { kind: "user", sourceId: "hal", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(await rowsOf(email)).toEqual({
      verified: 1,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    // The claim's time is 61 s old at its lease. The lease lives 60 s from its write, so the sweep kept it.
    expect(atLease).toHaveLength(1);
    expect(new Date(atLease[0]?.e ?? 0).getTime()).toBeGreaterThan(swept);
    expect(afterSweep).toEqual(atLease);
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

describe("a run that stops after the pending password create of a new unverified user on D1", () => {
  it("lists the user as partial with the password missing, and a repair after the sweep writes the password, which signs in", async () => {
    const email = "ivy@example.com";
    const record = () => [user("ivy", { email, emailVerified: false, password: { hash: BCRYPT } })];
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
      importUsers(createD1Adapter(dying), listSource(record()), { formats: ["bcrypt"] }),
    ).rejects.toBeInstanceOf(Error);
    expect(dead).toBe(true);
    const left = await env.DB.prepare(
      "SELECT p.hash AS hash FROM ta_password p JOIN ta_user u ON u.id = p.user_id WHERE u.email = ?",
    )
      .bind(email)
      .all<{ hash: string }>();
    expect(left.results.map((r) => r.hash.startsWith(PENDING_HASH_PREFIX))).toEqual([true]);
    // The user's sign-in with the imported password: no sign-in takes a pending row.
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
    // The dry run, as `import verify` runs it, lists the password as missing.
    const dry = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      dryRun: true,
    });
    expect(dry.exists.user).toBe(0);
    expect(dry.partial).toEqual([{ kind: "user", sourceId: "ivy", missing: ["password"] }]);
    expect(verifyReport(dry)).toMatchObject({ held: false, partial: 1, code: 1 });
    // The stopped run left its lease (plan 12q). The sweep deletes it after
    // 60 seconds. Then a run with --repair deletes the pending row and writes the password.
    await app(env.DB, { clock: { now: () => new Date(Date.now() + 61_000) } }).api.sweepExpired();
    const repair = await importUsers(createD1Adapter(env.DB), listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    expect(repair.partial).toEqual([]);
    expect(repair.repaired).toEqual([{ kind: "user", sourceId: "ivy", rows: ["password"] }]);
    expect(await rowsOf(email)).toEqual({
      verified: 0,
      passwords: 1,
      identities: [],
      sessions: 0,
    });
    expect(await claimantSignIn(email)).toBe("ok");
  });
});
