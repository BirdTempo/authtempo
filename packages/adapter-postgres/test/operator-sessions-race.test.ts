import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The end of all sessions beside the ban and the account delete (plan 12f
// Task 7 review m1), on the real Postgres adapter, through core's built
// output, with separate connections. With a `session.afterEnd` hook, each
// flow deletes the session rows one by one. `endAll` deletes them by id
// ascending. The ban and the delete hold the user row, then delete the
// user's rows in the order of their read. An update of an indexed column
// (`setActiveOrganization`) moves a row to the end of the heap, so an
// unsorted read gives another order than the id order, and the two
// transactions wait on each other. Each read that drives a delete now sorts
// by id. With no hook, one DELETE locks rows in the order of its scan, so a
// sort cannot help: each flow first takes the row locks by id
// (`lockInOrder`, ruling 36). Each row of the test makes its state through
// the flows.

const API = "https://api.example.com";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;
/** The pause of the probe: long enough for the other flow to take the rows it can (plan 12a Task 11). */
const HOLD_MS = 600;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * The engine on Postgres, with a `session.afterEnd` hook unless `hook` is
 * false, and one probe in its transactions. The probe runs once, after the
 * next session delete, on the same open transaction. It starts the other
 * flow and waits `HOLD_MS`.
 */
function world(options: { hook?: boolean } = {}) {
  const sent: MailMessage[] = [];
  const ended: string[] = [];
  let probe: (() => Promise<void>) | null = null;
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    delete: (async (model, where) => {
      const n = await tx.delete(model, where);
      const p = probe;
      if (model === "session" && p) {
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
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the order of the locks, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    ...(options.hook === false
      ? {}
      : {
          hooks: {
            session: {
              afterEnd: ({ session }) => {
                ended.push(session.id);
              },
            },
          },
        }),
  });
  const lastToken = (to: string) => {
    const text = sent.filter((x) => x.to === to).at(-1)?.text ?? "";
    const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
    if (!m?.[1]) throw new Error(`no token in the last mail to ${to}`);
    return decodeURIComponent(m[1]);
  };
  /** A sign-in by a magic link: the user on the first one. */
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const r = await auth.api.verifyMagicLink({
      token: lastToken(email),
      ip: null,
      userAgent: null,
    });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return s;
  }
  /** Arms the probe: after the next session delete, `start` runs and the transaction waits `HOLD_MS`. */
  function during(start: () => Promise<unknown>) {
    const started: { flow: Promise<unknown> | null } = { flow: null };
    probe = async () => {
      started.flow = start();
      // A rejection is read below, after the answer of endAll.
      started.flow.catch(() => {});
      await new Promise((r) => setTimeout(r, HOLD_MS));
    };
    return async () => {
      while (started.flow === null) await new Promise((r) => setTimeout(r, 10));
      return started.flow;
    };
  }
  return { auth, ended, signIn, during };
}

type World = ReturnType<typeof world>;

/**
 * A member of another user's organization with three sessions. The first
 * session sets the organization active, so its row leaves the id order of
 * the heap. Answers the user's three sessions.
 */
async function memberWithThreeSessions(w: World) {
  const s1 = await w.signIn("ada@example.com");
  const s2 = await w.signIn("ada@example.com");
  const s3 = await w.signIn("ada@example.com");
  // After the user's sessions, so endAll takes the first of them first.
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
  // The state of the race: the heap order of the user's rows is not the id order.
  const byHeap = await db.sql<{ id: string }[]>`
    SELECT id FROM ta_session WHERE user_id = ${s1.user.id} ORDER BY ctid`;
  const byId = [s1, s2, s3].map((s) => s.session.id).sort();
  expect(byHeap.map((r) => r.id)).not.toEqual(byId);
  // Only the events of the race count.
  w.ended.length = 0;
  return { owner, sessions: [s1, s2, s3] as const };
}

/** Both answers came, with no throw (no deadlock), and each is ok. */
async function settled(all: Promise<unknown>, other: () => Promise<unknown>) {
  const answers = await Promise.allSettled([all, other()]);
  for (const a of answers)
    expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
  for (const a of answers) expect(a.status === "fulfilled" && a.value).toMatchObject({ ok: true });
}

const endAll = (w: World) =>
  w.auth.api.operator.sessions.endAll({
    actor: APP,
    reason: "Breach",
    ip: null,
    userAgent: null,
  });

describe("the end of all sessions beside the ban and the account delete on Postgres (plan 12f Task 7)", () => {
  it("endAll with a hook beside the ban: no deadlock, and each session ends once", async () => {
    const w = world();
    const { owner, sessions } = await memberWithThreeSessions(w);
    const userId = sessions[0].user.id;
    const banning = w.during(() =>
      w.auth.api.operator.users.ban({
        actor: APP,
        userId,
        reason: "Race",
        ip: null,
        userAgent: null,
      }),
    );
    await settled(endAll(w), banning);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${userId}`).toHaveLength(0);
    // Between the two flows, each session ends once: one event per row.
    expect([...w.ended].sort()).toEqual([owner, ...sessions].map((s) => s.session.id).sort());
  }, 60_000);

  it("endAll with a hook beside the account delete of a member: no deadlock, and the user goes", async () => {
    const w = world();
    const { owner, sessions } = await memberWithThreeSessions(w);
    const userId = sessions[0].user.id;
    const deleting = w.during(() =>
      w.auth.api.user.delete({ session: sessions[2], ip: null, userAgent: null }),
    );
    await settled(endAll(w), deleting);
    expect(await db.sql`SELECT 1 FROM ta_user WHERE id = ${userId}`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${userId}`).toHaveLength(0);
    expect([...w.ended].sort()).toEqual([owner, ...sessions].map((s) => s.session.id).sort());
  }, 60_000);
});

/**
 * A member of another user's organization with a session in each of two
 * chunks of endAll: the first session, 50 sessions of another user, then
 * the second session. The first session sets the organization active, so
 * its row goes to the end of the heap, after the second.
 */
async function memberInTwoChunks(w: World) {
  const s1 = await w.signIn("ada@example.com");
  for (let i = 0; i < 50; i++) await w.signIn("filler@example.com");
  const s2 = await w.signIn("ada@example.com");
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
  const byHeap = await db.sql<{ id: string }[]>`
    SELECT id FROM ta_session WHERE user_id = ${s1.user.id} ORDER BY ctid`;
  expect(byHeap.map((r) => r.id)).toEqual([s2.session.id, s1.session.id]);
  return { sessions: [s1, s2] as const };
}

describe("the end of all sessions with no hook beside the ban and the account delete on Postgres (ruling 36)", () => {
  it("endAll with no hook beside the ban: no deadlock, and no session of the user stays", async () => {
    const w = world({ hook: false });
    const { sessions } = await memberInTwoChunks(w);
    const userId = sessions[0].user.id;
    // endAll deletes its first chunk by id in one statement; then the ban starts.
    const banning = w.during(() =>
      w.auth.api.operator.users.ban({
        actor: APP,
        userId,
        reason: "Race",
        ip: null,
        userAgent: null,
      }),
    );
    await settled(endAll(w), banning);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${userId}`).toHaveLength(0);
  }, 60_000);

  it("endAll with no hook beside the account delete of a member: no deadlock, and the user goes", async () => {
    const w = world({ hook: false });
    const { sessions } = await memberInTwoChunks(w);
    const userId = sessions[0].user.id;
    const deleting = w.during(() =>
      w.auth.api.user.delete({ session: sessions[1], ip: null, userAgent: null }),
    );
    await settled(endAll(w), deleting);
    expect(await db.sql`SELECT 1 FROM ta_user WHERE id = ${userId}`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${userId}`).toHaveLength(0);
  }, 60_000);
});
