import {
  type AuthConfig,
  type AuthEvent,
  createAuth,
  createPbkdf2PasswordHash,
  type StorageAdapter,
} from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The late delete of endAllAccessPage (access-end.ts) on the real Postgres
// adapter (ruling 25 of plan 12h, M1). The adapter runs READ COMMITTED. A
// password sign-in of an unverified user holds no user row (sessions.ts).
// So such a sign-in can commit a session after the ban read the sessions.
// The last delete of the ban takes that row, and session.end counts it.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;
const EMAIL = "late@example.com";
const PASSWORD = "correct horse battery";
/** The longest wait for the sign-in inside the probe. A wait on a lock of the ban never ends. */
const SIGN_IN_MS = 10_000;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** One engine on its own adapter, so its statements count only on its own counter. */
function engine(storage: StorageAdapter, batches: AuthEvent[][]) {
  const config: AuthConfig = {
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: { send: async () => {} },
    // A fast hash: the race, not the hash cost, is under test. The sign-in of an unverified user stays on.
    password: {
      hash: createPbkdf2PasswordHash({ iterations: 1000 }),
      uniformSignUp: false,
      requireVerified: false,
    },
    // operator.users needs organizations.platformRole or a secret with the users scope.
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    observe: { sink: { write: (b) => void batches.push([...b]) } },
  };
  return createAuth(config);
}

/**
 * The engine of the ban, with a probe in its transactions. The probe runs
 * once, after the session read of endAllAccessPage: the first `findMany` of
 * the model `session` by `userId` alone, with a limit. It awaits `run` on
 * the same open transaction.
 */
function banWorld() {
  const batches: AuthEvent[][] = [];
  let probe: (() => Promise<void>) | null = null;
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    findMany: (async (model, where, options) => {
      const rows = await tx.findMany(model, where, options);
      const run = probe;
      const byUser = where?.length === 1 && where[0]?.field === "userId";
      if (run && model === "session" && byUser && options?.limit !== undefined) {
        probe = null;
        await run();
      }
      return rows;
    }) as StorageAdapter["findMany"],
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
  };
  const auth = engine(storage, batches);
  return {
    auth,
    arm(run: () => Promise<void>) {
      probe = run;
    },
    armed: () => probe !== null,
    async events(): Promise<AuthEvent[]> {
      await auth.observe.flush();
      return batches.flat();
    },
  };
}

describe("the late delete of a ban on Postgres (ruling 25 of plan 12h)", () => {
  it("ends a session that a sign-in commits after the session read, and counts it", async () => {
    const w = banWorld();
    // The sign-in of the race runs on a second engine, with its own adapter and connection.
    const other = engine(createPostgresAdapter(db.sql), []);
    const password = w.auth.api.password;
    const late = other.api.password;
    if (!password || !late) throw new Error("password sign-in is off");
    const signIn = () =>
      password.signIn({ email: EMAIL, password: PASSWORD, ip: null, userAgent: null });
    // The sign-up opens the first session, and two sign-ins open two more: 3 sessions.
    const up = await password.signUp({
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const userId = up.value.user.id;
    for (let i = 0; i < 2; i++) {
      const r = await signIn();
      if (!r.ok || !("token" in r.value)) throw new Error("the sign-in opened no session");
    }
    const [unverified] = await db.sql<{ email_verified: boolean }[]>`
      SELECT email_verified FROM ta_user WHERE id = ${userId}`;
    expect(unverified?.email_verified).toBe(false);
    let raced: Awaited<ReturnType<typeof signIn>> | null = null;
    w.arm(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the sign-in waits on a lock of the ban")),
          SIGN_IN_MS,
        );
      });
      try {
        raced = await Promise.race([
          late.signIn({ email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
          stuck,
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    const before = (await w.events()).length;
    const banned = await w.auth.api.operator.users.ban({
      actor: APP,
      userId,
      reason: "Late sign-in",
      ip: null,
      userAgent: null,
    });
    expect(banned).toMatchObject({ ok: true });
    expect(w.armed()).toBe(false);
    // The sign-in committed its session before the ban committed.
    const r = raced as Awaited<ReturnType<typeof signIn>> | null;
    if (!r?.ok || !("token" in r.value)) throw new Error("the late sign-in opened no session");
    // The ban saw 3 sessions in its read. The late delete took the fourth.
    const ends = (await w.events()).slice(before).filter((e) => e.name === "session.end");
    expect(ends.map((e) => [e.reason, e.count])).toEqual([["banned", 4]]);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${userId}`).toHaveLength(0);
    // No pending-end row: the page ended every session that the read saw.
    expect(await db.sql`SELECT 1 FROM ta_verification WHERE purpose = 'session-end'`).toHaveLength(
      0,
    );
    expect(await w.auth.api.getSession(r.value.token)).toBeNull();
  }, 60_000);
});
