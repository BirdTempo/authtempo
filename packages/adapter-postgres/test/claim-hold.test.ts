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

/** The waits of `recording`, each run once and then cleared. */
interface Pause {
  hold: (() => Promise<void>) | null;
  read: (() => Promise<void>) | null;
}

/** The claim's hold as `recording` writes it: the conditional update of an unverified user row. */
const HOLD = "update user [id,emailVerified] [updatedAt]";

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A store that records each write of each transaction as
 * `<call> <model> [<where fields>] [<written fields>]`, in order. While
 * `pause.hold` is set, the next hold runs it once with the row lock held.
 * While `pause.read` is set, the next read of a user by address in a
 * transaction runs it once first.
 */
function recording(storage: StorageAdapter, pause: Pause) {
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
          findOne: async (m, w) => {
            const wait = pause.read;
            if (wait && m === "user" && w.some((x) => x.field === "email")) {
              pause.read = null;
              await wait();
            }
            return tx.findOne(m, w);
          },
          create: (m, d) => {
            calls.push(`create ${m} [] [${Object.keys(d).length}]`);
            return tx.create(m, d);
          },
          update: async (m, w, d) => {
            const call = `update ${m} [${fields(w)}] [${Object.keys(d).join(",")}]`;
            calls.push(call);
            const n = await tx.update(m, w, d);
            const wait = pause.hold;
            if (wait && call === HOLD) {
              pause.hold = null;
              await wait();
            }
            return n;
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

/**
 * The engine on Postgres, with a barrier in `user.beforeVerify` while
 * `gate.wait` is set. `gate.hold` and `gate.read` are the waits of `recording`.
 */
function world() {
  const sent: MailMessage[] = [];
  const after: string[] = [];
  const gate: Pause & { wait: (() => Promise<void>) | null } = {
    wait: null,
    hold: null,
    read: null,
  };
  const { store, runs } = recording(createPostgresAdapter(db.sql), gate);
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
        // Either way no row of the claimant stays.
        expect(rows).toEqual({
          users: 0,
          verified: null,
          passwords: 0,
          sessions: [],
          emailIdentities: 0,
          leases: 0,
        });
        // Three answers mean that the delete won. After its commit the delete removes the
        // links of the address (accountDeleted). So a claim that reads the link after that
        // commit answers 400 invalid_token. That order happens when the connection of the
        // claim is cold (seen 6 of 6 runs of this test alone on 2026-11-13). The test held
        // ok and conflict only, so it failed there although the delete had won.
        if (!claim.ok) expect(["conflict", "invalid_token"]).toContain(claim.code);
        if (claim.ok) {
          // The claim's user is a new one, so the claimant holds nothing of it.
          if (!("token" in claim.value)) throw new Error("the claim opened no session");
          const mine = await w.auth.api.getSession(claim.value.token);
          expect(mine?.user.email).toBe(email);
          expect(mine?.user.emailVerified).toBe(true);
          expect(mine?.user.id).not.toBe(userId);
          expect(mine?.session.userId).not.toBe(userId);
        }
      } else {
        // The claim took the row first and ended the claimant's session, so the delete has no session.
        expect(claim.ok).toBe(true);
        expect(rows).toMatchObject({ users: 1, verified: true, passwords: 0 });
      }
    }
  }, 60_000);

  it("serves a claim that reads the user after an account delete ended: a new user, and no row of the claimant", async () => {
    // The race above met this order in no round: the delete won each one,
    // and the claim answered conflict. So here the claim starts first and
    // waits before its user read. The delete runs to its commit in that
    // wait. Then the claim finds no user, and the proof makes a new one.
    const w = world();
    const email = "after@example.com";
    const { userId, token } = await w.claimant(email);
    const session = await w.auth.api.getSession(token);
    if (!session) throw new Error("no session");
    const link = await w.link(email);
    const atRead = latch();
    const goRead = latch();
    w.gate.read = async () => {
      atRead.open();
      await goRead.wait;
    };
    const claim = w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    await atRead.wait;
    const gone = await w.auth.api.user.delete({ session, ip: null, userAgent: null });
    expect(gone.ok).toBe(true);
    goRead.open();
    const won = await claim;
    if (!won.ok || !("token" in won.value)) throw new Error("the claim opened no session");
    const mine = await w.auth.api.getSession(won.value.token);
    expect(mine?.user.email).toBe(email);
    expect(mine?.user.emailVerified).toBe(true);
    expect(mine?.user.id).not.toBe(userId);
    expect(mine?.session.userId).not.toBe(userId);
    expect(await rowsOf(userId)).toEqual({
      users: 0,
      verified: null,
      passwords: 0,
      sessions: [],
      emailIdentities: 0,
      leases: 0,
    });
  });

  it("serves a claim that holds the user row and an account delete that starts in the hold: the delete refuses, with no deadlock", async () => {
    // The order of probe H3 of the Task 2b review. The claim takes its hold,
    // then waits 150 ms with the row lock. The delete starts in that wait
    // and waits for the lock. After the claim's commit the delete reads its
    // proof session, which the claim ended, and answers unauthorized.
    for (let round = 0; round < ROUNDS; round++) {
      const w = world();
      const email = `held-${round}@example.com`;
      const { userId, token } = await w.claimant(email);
      const session = await w.auth.api.getSession(token);
      if (!session) throw new Error("no session");
      const link = await w.link(email);
      const held = latch();
      w.gate.hold = async () => {
        held.open();
        await new Promise((r) => setTimeout(r, 150));
      };
      const claim = w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
      await held.wait;
      const [won, gone] = await Promise.all([
        claim,
        w.auth.api.user.delete({ session, ip: null, userAgent: null }),
      ]);
      expect(won.ok).toBe(true);
      expect(gone.ok ? "ok" : gone.code).toBe("unauthorized");
      if (!won.ok || !("token" in won.value)) throw new Error("the claim opened no session");
      const mine = await w.auth.api.getSession(won.value.token);
      expect(mine?.user.id).toBe(userId);
      expect(await rowsOf(userId)).toEqual({
        users: 1,
        verified: true,
        passwords: 0,
        sessions: [mine?.session.id],
        emailIdentities: 1,
        leases: 0,
      });
    }
  }, 60_000);
});
