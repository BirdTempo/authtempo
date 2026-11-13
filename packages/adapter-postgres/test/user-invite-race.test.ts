import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The invitation link of plan 12f2 Task 3 on the real Postgres adapter,
// with separate connections (review-12f2-task3 L1, ruling 13 L1 of plan
// 12f2). Each test asserts what must hold whatever the order of the
// commits, and runs several rounds to meet more orders.

const API = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = { reason: "Ticket 1", ip: null, userAgent: null };
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 8;
/** The pause of the probe: long enough for the other flow to reach the rows it can. */
const HOLD_MS = 400;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * Core on Postgres with the user tools, and a `session.afterEnd` hook. With
 * `probe`, the first user update of a transaction (the lock of the user row)
 * runs `probe.run` once on that open transaction.
 */
function world(probe: { run: (() => Promise<void>) | null } = { run: null }) {
  const sent: MailMessage[] = [];
  const ended: string[] = [];
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    async update(model, where, data) {
      const n = await tx.update(model, where, data);
      const run = probe.run;
      if (model === "user" && run) {
        probe.run = null;
        await run();
      }
      return n;
    },
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
  };
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: { send: async (m) => void sent.push(m) },
    operator: {
      users: true,
      secrets: [{ name: "support", secretHash: "e".repeat(64), scopes: ["users", "delete"] }],
    },
    hooks: { session: { afterEnd: ({ session }) => void ended.push(session.id) } },
  });
  const post = (path: string, body: unknown) =>
    auth.handle(
      new Request(`${API}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const lastToken = (to: string) => {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(sent.filter((x) => x.to === to).at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error(`no token to ${to}`);
    return decodeURIComponent(m[1]);
  };
  const create = async (email: string) => {
    const made = await auth.api.operator.users.create({ actor: APP, email, ...REASON });
    if (!made.ok) throw new Error(made.code);
    return made.value.userId;
  };
  return { auth, post, lastToken, create, ended, storage };
}

/** The rows that name the user: the user, identity, session, member, and verification rows. */
async function rowsOf(userId: string) {
  const counts: Record<string, number> = {};
  const [user] = await db.sql`SELECT count(*)::int AS n FROM ta_user WHERE id = ${userId}`;
  counts.user = user?.n ?? -1;
  for (const table of ["ta_identity", "ta_session", "ta_member"]) {
    const [row] =
      await db.sql`SELECT count(*)::int AS n FROM ${db.sql(table)} WHERE user_id = ${userId}`;
    counts[table] = row?.n ?? -1;
  }
  const [links] =
    await db.sql`SELECT count(*)::int AS n FROM ta_verification WHERE identifier = ${userId} AND purpose <> 'session-end'`;
  counts.verification = links?.n ?? -1;
  return counts;
}

const NO_ROW = { user: 0, ta_identity: 0, ta_session: 0, ta_member: 0, verification: 0 };

describe("the invitation confirm on Postgres (plan 12f2 Task 3)", () => {
  it("two confirms of one link at once: one session, and one invalid_token", async () => {
    const w = world();
    for (let i = 0; i < ROUNDS; i++) {
      const email = `p${i}@example.com`;
      const userId = await w.create(email);
      const token = w.lastToken(email);
      const res = await Promise.all([
        w.post("/user/invite/confirm", { token }),
        w.post("/user/invite/confirm", { token }),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
      const sessions = await w.storage.findMany("session", [
        { field: "userId", op: "eq", value: userId },
      ]);
      expect(sessions).toHaveLength(1);
    }
  }, 60_000);

  it("a confirm and a magic link of one unverified user at once: both sign in, one identity", async () => {
    const w = world();
    for (let i = 0; i < ROUNDS; i++) {
      const email = `m${i}@example.com`;
      const userId = await w.create(email);
      const invite = w.lastToken(email);
      expect((await w.post("/magic-link/request", { email })).status).toBe(200);
      const link = w.lastToken(email);
      const res = await Promise.all([
        w.post("/user/invite/confirm", { token: invite }),
        w.post("/magic-link/verify", { token: link }),
      ]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
      const user = await w.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
      expect(user?.emailVerified).toBe(true);
      const identities = await w.storage.findMany("identity", [
        { field: "userId", op: "eq", value: userId },
      ]);
      expect(identities).toHaveLength(1);
      // The claim of the second ends the session of the first: each end fires once.
      expect(new Set(w.ended).size).toBe(w.ended.length);
    }
  }, 60_000);

  for (const emailVerified of [false, true])
    it(`a confirm while the operator delete holds the user row (verified ${emailVerified}): no row of the user stays`, async () => {
      const probe: { run: (() => Promise<void>) | null } = { run: null };
      const deleter = world(probe);
      const w = world();
      for (let i = 0; i < 4; i++) {
        const email = `h${i}@example.com`;
        const made = await w.auth.api.operator.users.create({
          actor: APP,
          email,
          emailVerified,
          ...REASON,
        });
        if (!made.ok) throw new Error(made.code);
        const userId = made.value.userId;
        const token = w.lastToken(email);
        let confirmed: Promise<Response> | null = null;
        probe.run = async () => {
          confirmed = w.post("/user/invite/confirm", { token });
          await new Promise((r) => setTimeout(r, HOLD_MS));
        };
        const deleted = await deleter.auth.api.operator.users.delete({
          actor: APP,
          userId,
          ...REASON,
        });
        expect(deleted).toMatchObject({ ok: true });
        const res = await (confirmed as Promise<Response> | null);
        if (!res) throw new Error("the probe did not run");
        // The confirm waits on the lock of the user row, then finds the user gone.
        expect([res.status, await res.json()]).toEqual([409, { error: "conflict" }]);
        expect(await rowsOf(userId)).toEqual(NO_ROW);
      }
    }, 60_000);

  it("a confirm and an operator delete at once: the delete wins, and no row of the user stays", async () => {
    const w = world();
    for (let i = 0; i < ROUNDS; i++) {
      const email = `d${i}@example.com`;
      const userId = await w.create(email);
      const token = w.lastToken(email);
      const [res, gone] = await Promise.all([
        w.post("/user/invite/confirm", { token }),
        w.auth.api.operator.users.delete({ actor: APP, userId, ...REASON }),
      ]);
      expect(gone.ok).toBe(true);
      // Two answers mean that the delete won. When the delete commits after the confirm
      // reads the link, the confirm answers 409 conflict (or 200 when it finished first).
      // When the delete commits before the confirm reads the link, the link is gone, and
      // the confirm answers 400 invalid_token. The second order happens in round 0, where
      // the connection of the confirm is cold (seen 4 of 4 runs on 2026-11-13). The test
      // held 200 and 409 only, so it failed there although the delete had won.
      if (res.status === 400) expect(await res.json()).toEqual({ error: "invalid_token" });
      else expect([200, 409]).toContain(res.status);
      expect(await rowsOf(userId)).toEqual(NO_ROW);
    }
  }, 60_000);
});
