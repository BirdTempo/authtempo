import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The row locks of the session deletes with three flows on Postgres
// (rulings 36 and 37 of plan 12f). The test runs core's built output on
// separate connections. A third flow holds the lock of one session row
// between two rows of the target in id order. Then the two flows under
// test start: each must take its row locks by id, or each waits on the
// other. Every row comes from the flows. The one device is the pause of
// the race test. A transaction waits after a session delete that removed
// a row, while the other flows start.

const API = "https://api.example.com";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;
/** The pause of the third flow, long enough for the two flows to take the rows they can. */
const HOLD_MS = 700;
/** The gap between the starts of the two flows, so the first one takes its first lock first. */
const GAP_MS = 200;
const HOUR_MS = 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * The engine on Postgres with no hook, a clock, sessions of one day, and a
 * slide of 6 hours. `arm` sets a probe that runs once, after the next
 * session delete in a transaction that removed a row, on that open
 * transaction.
 */
function world() {
  const sent: MailMessage[] = [];
  let probe: (() => Promise<void>) | null = null;
  let current = new Date("2026-10-21T00:00:00.000Z");
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    delete: (async (model, where) => {
      const n = await tx.delete(model, where);
      const p = probe;
      if (model === "session" && n > 0 && p) {
        probe = null;
        await p();
      }
      return n;
    }) as typeof tx.delete,
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
    clock: { now: () => current },
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the order of the locks, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { ttlDays: 1, slidingRefreshDays: 0.25 },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
  });
  /** A sign-in by a magic link, 10 ms after the one before, so the ids follow the order of the calls. */
  async function signIn(email: string) {
    current = new Date(current.getTime() + 10);
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.filter((x) => x.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  return {
    auth,
    signIn,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    arm: (p: () => Promise<void>) => {
      probe = p;
    },
  };
}

type World = ReturnType<typeof world>;

/**
 * User u has the sessions s1 < x < s2 < s3 by id, and x is the session of
 * user v. s1 sets an organization active, so its row leaves the id order
 * of the heap. A DELETE in scan order takes s1 last.
 */
async function state(w: World) {
  const s1 = await w.signIn("u@example.com");
  const x = await w.signIn("v@example.com");
  const s2 = await w.signIn("u@example.com");
  const s3 = await w.signIn("u@example.com");
  const owner = await w.signIn("owner@example.com");
  const org = await w.auth.api.createOrganization({ user: owner.user, slug: "org", name: "Org" });
  if (!org.ok) throw new Error(org.code);
  const organizationId = org.value.organization.id;
  const added = await w.auth.api.addMember({
    user: owner.user,
    organizationId,
    userId: s1.user.id,
    role: "member",
  });
  if (!added.ok) throw new Error(added.code);
  const active = await w.auth.api.setActiveOrganization({ session: s1, organizationId });
  if (!active.ok) throw new Error(active.code);
  const byHeap = await db.sql<{ id: string }[]>`SELECT id FROM ta_session ORDER BY ctid`;
  expect(byHeap.at(-1)?.id).toBe(s1.session.id);
  expect([s1, x, s2, s3].map((s) => s.session.id)).toEqual(
    [s1, x, s2, s3].map((s) => s.session.id).sort(),
  );
  return { s1, x, s2, s3, owner };
}

const endAll = (w: World) =>
  w.auth.api.operator.sessions.endAll({ actor: APP, reason: "Breach", ip: null, userAgent: null });

const ban = (w: World, userId: string) =>
  w.auth.api.operator.users.ban({ actor: APP, userId, reason: "Race", ip: null, userAgent: null });

/**
 * The ban of v runs, and after it deletes x it holds x while `first` and
 * then `second` start. Answers the three outcomes, each `ok` or the message
 * of its throw.
 */
async function race(
  w: World,
  vId: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const flows: Promise<unknown>[] = [];
  w.arm(async () => {
    flows.push(first());
    await sleep(GAP_MS);
    flows.push(second());
    await sleep(HOLD_MS);
  });
  const third = await Promise.allSettled([ban(w, vId)]);
  while (flows.length < 2) await sleep(10);
  const answers = [...third, ...(await Promise.allSettled(flows))];
  return answers.map((a) =>
    a.status === "rejected" ? String((a.reason as Error)?.message ?? a.reason) : "ok",
  );
}

describe("the sweep of expired sessions beside endAll on Postgres (ruling 37 m1)", () => {
  for (let round = 1; round <= 2; round++)
    it(`round ${round}: no deadlock while a ban holds a row between two expired rows`, async () => {
      const w = world();
      const st = await state(w);
      // x slides its expiry at 12 hours; the rows of u and the owner expire at 24 hours.
      w.advance(12 * HOUR_MS);
      if (!(await w.auth.api.getSession(st.x.token))) throw new Error("x ended");
      w.advance(13 * HOUR_MS);
      const outcomes = await race(
        w,
        st.x.user.id,
        () => endAll(w),
        () => w.auth.api.sweepExpired(),
      );
      expect(outcomes).toEqual(["ok", "ok", "ok"]);
      expect(await db.sql`SELECT id FROM ta_session`).toEqual([]);
    }, 60_000);
});

describe("endAll beside the ban on Postgres while a third flow holds a row (ruling 36, review m2)", () => {
  for (let round = 1; round <= 2; round++)
    it(`round ${round}: no deadlock, and no session stays`, async () => {
      const w = world();
      const st = await state(w);
      // endAll takes s1 and waits on x; the ban of u needs s1, s2, and s3. Each flow takes its
      // locks by id, so the ban of u waits on endAll, and endAll waits on the ban of v alone.
      const outcomes = await race(
        w,
        st.x.user.id,
        () => endAll(w),
        () => ban(w, st.s1.user.id),
      );
      expect(outcomes).toEqual(["ok", "ok", "ok"]);
      expect(await db.sql`SELECT id FROM ta_session`).toEqual([]);
    }, 60_000);
});
