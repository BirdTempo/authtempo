import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The hold of a claim on Postgres (ruling 16 of plan 12p). Postgres isolates
// a transaction, so the first statement of a claim is the hold: an update of
// the user row while it is unverified. It takes the lock of the user row
// first, the lock order of user-hold.ts, and the claim writes no lease.
// Every row comes from a real request, through core's built output, with
// separate connections. Each race runs several rounds to meet more orders;
// a test that passes proves the orders it met, not every order.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 5;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * A store that records each write of each transaction as
 * `<call> <model> [<where fields>] [<written fields>]`, in order.
 */
function recording(storage: StorageAdapter) {
  const runs: string[][] = [];
  const store: StorageAdapter = {
    ...storage,
    transaction: <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      storage.transaction((tx) => {
        const calls: string[] = [];
        runs.push(calls);
        const fields = (w: { field: string }[]) => w.map((x) => x.field).join(",");
        return fn({
          ...tx,
          create: (m, d) => {
            calls.push(`create ${m} [] [${Object.keys(d).length}]`);
            return tx.create(m, d);
          },
          update: (m, w, d) => {
            calls.push(`update ${m} [${fields(w)}] [${Object.keys(d).join(",")}]`);
            return tx.update(m, w, d);
          },
          delete: (m, w) => {
            calls.push(`delete ${m} [${fields(w)}]`);
            return tx.delete(m, w);
          },
          deleteRows: (m, w) => {
            calls.push(`deleteRows ${m} [${fields(w)}]`);
            return tx.deleteRows(m, w);
          },
        });
      }),
  };
  return { store, runs };
}

/** The engine on Postgres, with a barrier in `user.beforeVerify` while `gate.wait` is set. */
function world() {
  const sent: MailMessage[] = [];
  const after: string[] = [];
  const gate: { wait: (() => Promise<void>) | null } = { wait: null };
  const { store, runs } = recording(createPostgresAdapter(db.sql));
  const auth = createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage: store,
    limiter: OPEN,
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    mail: { send: async (m) => void sent.push(m) },
    hooks: {
      user: {
        beforeVerify: async () => {
          await gate.wait?.();
        },
        afterVerify: ({ user }) => void after.push(user.id),
      },
      // An `afterEnd` hook: the claim reads its sessions and ends them by `deleteRows`.
      session: { afterEnd: () => {} },
    },
  });
  /** A new magic link of `email`: its token. */
  async function link(email: string): Promise<string> {
    expect((await auth.api.requestMagicLink({ email, ip: null })).ok).toBe(true);
    const m = sent.findLast((x) => x.to === email && /token=/.test(x.text));
    return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1] ?? "");
  }
  /** The claimant: a password sign-up of `email`, unverified, with its session. */
  async function claimant(email: string) {
    const up = await auth.api.password?.signUp({
      email,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up?.ok || !("session" in up.value)) throw new Error("no sign-up session");
    return { userId: up.value.user.id, token: up.value.token };
  }
  return { auth, runs, after, gate, link, claimant };
}

/** The rows of a user that a claim reads or writes. */
async function rowsOf(userId: string) {
  const count = async (table: string) =>
    Number(
      (
        await db.sql.unsafe<{ n: string }[]>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = $1`,
          [userId],
        )
      )[0]?.n ?? 0,
    );
  const user = await db.sql<{ v: boolean }[]>`
    SELECT email_verified AS v FROM ta_user WHERE id = ${userId}`;
  const leases = await db.sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM ta_verification WHERE purpose = 'claim-lease'`;
  return {
    users: user.length,
    verified: user[0]?.v ?? null,
    passwords: await count("ta_password"),
    sessions: (
      await db.sql<{ id: string }[]>`SELECT id FROM ta_session WHERE user_id = ${userId}`
    ).map((r) => r.id),
    emailIdentities: Number(
      (
        await db.sql<{ n: string }[]>`
        SELECT COUNT(*) AS n FROM ta_identity WHERE user_id = ${userId} AND provider = 'email'`
      )[0]?.n ?? 0,
    ),
    leases: Number(leases[0]?.n ?? 0),
  };
}

describe("the hold of a claim on Postgres (ruling 16 of plan 12p)", () => {
  it("takes the user row in the claim's first statement, and writes no lease", async () => {
    const w = world();
    const { userId } = await w.claimant("ada@example.com");
    const token = await w.link("ada@example.com");
    const mark = w.runs.length;
    const r = await w.auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    expect(r.ok).toBe(true);
    const claim = w.runs
      .slice(mark)
      .find((calls) => calls.includes("delete identity [userId,provider]"));
    if (!claim) throw new Error("no claim ran");
    const hold = claim.indexOf("update user [id,emailVerified] [updatedAt]");
    const deletes = claim.indexOf("delete identity [userId,provider]");
    // The hold, then the five deletes, then the flip, then the sessions.
    expect(claim.slice(hold, deletes + 7)).toEqual([
      "update user [id,emailVerified] [updatedAt]",
      "delete identity [userId,provider]",
      "delete password [userId]",
      "delete passkey [userId]",
      "delete verification [purpose,identifier]",
      "delete verification [purpose,identifier]",
      "update user [id,emailVerified] [emailVerified,username,displayUsername,phone,updatedAt]",
      "deleteRows session [userId,id]",
    ]);
    // No write of the user row comes between the claim's read and its hold, and no lease is written.
    expect(claim.some((c) => c.startsWith("create verification"))).toBe(false);
    expect(await rowsOf(userId)).toMatchObject({ verified: true, passwords: 0, leases: 0 });
  });

  it("serves two proofs of one user at once: one claim, the other signs in after the lock, and no deadlock", async () => {
    // A barrier in user.beforeVerify lets both flows read the unverified row
    // before either claims. The first hold takes the row lock. The second
    // waits for that commit, then matches no unverified row. Its retry reads
    // the verified user and signs in: Postgres runs claim retries (claimRetry).
    for (let round = 0; round < ROUNDS; round++) {
      const w = world();
      const email = `twice-${round}@example.com`;
      const { userId } = await w.claimant(email);
      const links = [await w.link(email), await w.link(email)];
      let arrived = 0;
      let release: () => void = () => {};
      const together = new Promise<void>((r) => {
        release = r;
      });
      w.gate.wait = async () => {
        arrived += 1;
        if (arrived === 2) release();
        // A flow that waits more than 2 s goes on alone: the test then fails on its counts.
        await Promise.race([together, new Promise((r) => setTimeout(r, 2_000))]);
      };
      const answers = await Promise.all(
        links.map((token) => w.auth.api.verifyMagicLink({ token, ip: null, userAgent: null })),
      );
      w.gate.wait = null;
      expect(arrived).toBe(2);
      expect(answers.map((a) => a.ok)).toEqual([true, true]);
      // One claim: one afterVerify. The tables are as the claim left them, with two new sessions.
      expect(w.after).toEqual([userId]);
      const sessions: string[] = [];
      for (const a of answers) {
        if (!a.ok || !("token" in a.value)) throw new Error("a proof opened no session");
        sessions.push((await w.auth.api.getSession(a.value.token))?.session.id ?? "");
      }
      const rows = await rowsOf(userId);
      expect({ ...rows, sessions: rows.sessions.sort() }).toEqual({
        users: 1,
        verified: true,
        passwords: 0,
        sessions: sessions.sort(),
        emailIdentities: 1,
        leases: 0,
      });
    }
  }, 60_000);

  it("serves a claim and an account delete of one user at once with no deadlock", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = world();
      const email = `gone-${round}@example.com`;
      const { userId, token } = await w.claimant(email);
      const session = await w.auth.api.getSession(token);
      if (!session) throw new Error("no session");
      const link = await w.link(email);
      const [claim, gone] = await Promise.all([
        w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null }),
        w.auth.api.user.delete({ session, ip: null, userAgent: null }),
      ]);
      const rows = await rowsOf(userId);
      if (gone.ok) {
        // The delete took the user row first. The claim found no user: 409,
        // or a new user of the address when it read after the commit.
        expect(rows.users).toBe(0);
        expect(claim.ok || claim.code === "conflict").toBe(true);
      } else {
        // The claim took the row first and ended the claimant's session, so the delete has no session.
        expect(claim.ok).toBe(true);
        expect(rows).toMatchObject({ users: 1, verified: true, passwords: 0 });
      }
    }
  }, 60_000);
});
