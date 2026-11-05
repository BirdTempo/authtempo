import { createPostgresAdapter } from "@authtempo/adapter-postgres";
import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importUsers } from "../src/import.js";
import { freshSchema, migrateWithoutLock } from "./pg.js";
import { BCRYPT, listSource, user } from "./source.js";

// The importer holds the claim of an unverified user for its writes on
// Postgres (decision 5 of plan 12q). There the hold is core's conditional
// update of the user row, the first statement of a claim. It takes the row
// lock before the import's first credential write. So the owner's claim
// waits for the import's commit, and then it deletes what the import wrote.
// A new user is not visible to the claim before the commit. The owner's
// create waits on the unique key of the address, and its retry claims. The
// test file of the D1 hold is test/d1/import-d1-hold.test.ts.

/** The plaintext of BCRYPT in ./source.ts. */
const PLAIN = "allmine";
/** The time that the owner's link must stay open while the import holds the user. */
const WAIT_MS = 500;

let pg: { sql: Sql; close(): Promise<void> };
let storage: StorageAdapter;

beforeAll(async () => {
  pg = await freshSchema();
  await migrateWithoutLock(pg.sql);
  storage = createPostgresAdapter(pg.sql);
});
afterAll(async () => {
  await pg.close();
});

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A view of `db` whose transactions wait after the first create of `model`. */
function pauseAfterCreate(db: StorageAdapter, model: string) {
  const reached = latch();
  const go = latch();
  let paused = false;
  const view: StorageAdapter = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          create: async (m, data) => {
            const row = await tx.create(m, data);
            if (!paused && m === model) {
              paused = true;
              reached.open();
              await go.wait;
            }
            return row;
          },
        }),
      ),
  };
  return { db: view, reached: reached.wait, go: go.open };
}

const mail: MailMessage[] = [];
/** The app on the same schema. It verifies bcrypt, as an app that imported such hashes does. */
function app() {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
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

/** The owner's magic link of `email`: its verify, which answers "ok a session" or the error code. */
async function ownerLink(email: string): Promise<string> {
  expect((await app().api.requestMagicLink({ email, ip: null })).ok).toBe(true);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const out = await app().api.verifyMagicLink({ token, ip: null, userAgent: null });
  return out.ok ? ("token" in out.value ? "ok a session" : "ok") : out.code;
}

/** "open" when `p` has not settled after WAIT_MS. */
async function stillOpen(p: Promise<unknown>): Promise<string> {
  return Promise.race([
    p.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("open"), WAIT_MS)),
  ]);
}

async function claimantSignIn(email: string): Promise<string | undefined> {
  const out = await app().api.password?.signIn({
    email,
    password: PLAIN,
    ip: null,
    userAgent: null,
  });
  return out?.ok ? "ok" : (out as { code?: string } | undefined)?.code;
}

async function rowsOf(email: string) {
  const [u] = await pg.sql<{ id: string; v: boolean }[]>`
    SELECT id, email_verified AS v FROM ta_user WHERE email = ${email}`;
  const id = u?.id ?? "";
  const passwords = await pg.sql`SELECT id FROM ta_password WHERE user_id = ${id}`;
  const identities = await pg.sql<{ provider: string }[]>`
    SELECT provider FROM ta_identity WHERE user_id = ${id} ORDER BY provider`;
  const sessions = await pg.sql`SELECT id FROM ta_session WHERE user_id = ${id}`;
  return {
    verified: u?.v,
    passwords: passwords.length,
    identities: identities.map((r) => r.provider),
    sessions: sessions.length,
  };
}

describe("the import holds the claim of an unverified user on Postgres", () => {
  it("makes the owner's link wait while a repair writes, and the link claims after the commit", async () => {
    const email = "ann@example.com";
    const record = () => [user("ann", { email, emailVerified: false, password: { hash: BCRYPT } })];
    // The first run refuses the hash, so the user comes in with no password (spec 17.1).
    await importUsers(storage, listSource(record()), { formats: [] });
    const run = pauseAfterCreate(storage, "password");
    const repair = importUsers(run.db, listSource(record()), {
      formats: ["bcrypt"],
      repair: true,
    });
    await run.reached;
    // The hold took the row lock before the password write, so the claim's hold waits.
    const link = ownerLink(email);
    const during = await stillOpen(link);
    // The pause ends before the check, so a failed check leaves no open transaction.
    run.go();
    expect(during).toBe("open");
    expect((await repair).repaired).toEqual([
      { kind: "user", sourceId: "ann", rows: ["password"] },
    ]);
    expect(await link).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: true,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
    expect(await claimantSignIn(email)).toBe("invalid_credentials");
  });

  it("makes the owner's link wait on the key of a new user, and its retry claims after the commit", async () => {
    const email = "ben@example.com";
    const run = pauseAfterCreate(storage, "identity");
    const report = importUsers(
      run.db,
      listSource([
        user("ben", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-ben" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    // The new user is not visible yet: the owner's create waits on the unique key of the address.
    const link = ownerLink(email);
    const during = await stillOpen(link);
    run.go();
    expect(during).toBe("open");
    expect((await report).created.identity).toBe(1);
    expect(await link).toBe("ok a session");
    expect(await rowsOf(email)).toEqual({
      verified: true,
      passwords: 0,
      identities: ["email"],
      sessions: 1,
    });
  });

  it("rolls back and skips the record when another import takes the identity before the activation (ruling 24)", async () => {
    const email = "cy@example.com";
    // The import waits after its pending identity write, inside its transaction.
    const run = pauseAfterCreate(storage, "identity");
    const report = importUsers(
      run.db,
      listSource([
        user("cy", {
          email,
          emailVerified: false,
          identities: [{ provider: "google", subject: "g-cy" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    await run.reached;
    // Another import writes a verified user with the same Google login and commits.
    const other = await importUsers(
      storage,
      listSource([
        user("dee", {
          email: "dee@example.com",
          identities: [{ provider: "google", subject: "g-cy" }],
        }),
      ]),
      { formats: ["bcrypt"] },
    );
    expect(other.created).toMatchObject({ user: 1, identity: 2 });
    run.go();
    // The activation meets the key of the provider and the subject. Postgres
    // aborts the transaction, so the import rolls back and plans the record again.
    const r = await report;
    expect(r.skipped).toEqual([{ kind: "user", sourceId: "cy", reason: "identity_taken" }]);
    expect(r.partial).toEqual([]);
    expect(await rowsOf(email)).toEqual({
      verified: undefined,
      passwords: 0,
      identities: [],
      sessions: 0,
    });
    expect(await rowsOf("dee@example.com")).toMatchObject({ identities: ["email", "google"] });
  });
});
