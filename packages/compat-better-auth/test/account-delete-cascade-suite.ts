import {
  type AuthConfig,
  createAuth,
  type MailMessage,
  type OperatorAuditRow,
  type ResolvedSession,
  type StorageAdapter,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { expect, it } from "vitest";
import type { CompatDatabase } from "../src/types.js";
import { adminApp, cookieOf, PASSWORD, APP as SETUP } from "./admin-helpers.js";

// Ruling 13 of plan 12f2 (final-12f2-B H1 and M1). On the Better Auth
// tables a user delete cascades to the sessions, the accounts, and the
// member rows, and an organization delete to its member rows. Core's
// account delete must run every check that can refuse, and its session
// pages, before the user delete. The D1 and the Postgres files run this
// suite on their own storage.

const APP = { kind: "app", name: "support-tool" } as const;

/** One store of the suite. */
export interface CascadeStore {
  /** The storage for the scene setup, and the database of the shim. */
  database: CompatDatabase;
  /**
   * The storage of one delete invocation, and its count of queries. D1
   * gives a new storage over a counting binding; Postgres gives the same
   * storage and no count.
   */
  act(): { storage: StorageAdapter; queries(): number | null };
  /**
   * The answer of `/admin/remove-user` of a solo owner by a platform
   * operator. On D1 the least work of that act cannot fit 50 queries, so
   * it answers `delete_too_large` before any write (rulings 5 and 10).
   */
  removeSolo: "removed" | "too_large";
  /**
   * The own sessions that a delete with a `session.afterEnd` hook ends in its
   * page, in the scene of 501 own sessions and 3 impersonation sessions.
   * Default 500: off D1 the page holds 500 rows. On D1 the call budget bounds it.
   */
  ownPage?: number;
  /**
   * The stop rows that one sweep of 50 calls writes in the scene of 501 own
   * sessions and 40 impersonation sessions. Review Focus 3 of plan 12o asks
   * for it. The runner of each store gives its measure, with the date.
   */
  sweepStops: number;
}

/** The rows that name one user, read through core's models. */
export async function rowsOf(storage: StorageAdapter, userId: string, organizationId: string) {
  const byUser = [{ field: "userId", op: "eq", value: userId }] as const;
  return {
    user: (await storage.findOne("user", [{ field: "id", op: "eq", value: userId }])) !== null,
    sessions: (await storage.findMany("session", [...byUser])).length,
    identities: (await storage.findMany("identity", [...byUser])).length,
    passwords: (await storage.findMany("password", [...byUser])).length,
    members: (await storage.findMany("member", [...byUser])).length,
    organization:
      (await storage.findOne("organization", [
        { field: "id", op: "eq", value: organizationId },
      ])) !== null,
  };
}

/** Core on `storage`, with a `session.afterEnd` hook that counts, and the mail in `sent`. */
export function engine(
  storage: StorageAdapter,
  sent: MailMessage[],
  extra: Partial<AuthConfig> = {},
) {
  const ends: string[] = [];
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    // The scenes open up to 501 sessions of one user: the default cap is 100 (plan 12q).
    session: { maxPerUser: 1000 },
    ...extra,
    hooks: { ...extra.hooks, session: { afterEnd: (e) => void ends.push(e.session.id) } },
  });
  return { auth, ends };
}

/** A session of `email` by a magic link: the first one makes a verified user. */
async function signIn(
  auth: ReturnType<typeof engine>["auth"],
  sent: MailMessage[],
  email: string,
): Promise<ResolvedSession> {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const s = await auth.api.getSession(r.value.token);
  if (!s) throw new Error("no session");
  return s;
}

let scenes = 0;

/** A verified user with `sessions` sessions who owns one organization alone. */
export async function soloOwner(store: CascadeStore, sessions: number) {
  scenes++;
  const sent: MailMessage[] = [];
  const { auth } = engine(store.database.storage, sent);
  const email = `owner${scenes}@example.com`;
  let me = await signIn(auth, sent, email);
  for (let i = 1; i < sessions; i++) me = await signIn(auth, sent, email);
  const made = await auth.api.createOrganization({
    user: me.user,
    slug: `solo-${scenes}`,
    name: `Solo ${scenes}`,
  });
  if (!made.ok) throw new Error(made.code);
  return { auth, sent, me, organizationId: made.value.organization.id };
}

type Setup = Awaited<ReturnType<typeof adminApp>>;

/**
 * The app of the admin plugin on one database, made once, because its first
 * operator holds one fixed address. Its limiter allows all, as an app can set
 * it. So a scene can sign in 501 times and start 101 impersonations.
 */
const setups = new WeakMap<CompatDatabase, Promise<Setup>>();
export function setupOf(database: CompatDatabase): Promise<Setup> {
  // The scenes open up to 501 own sessions of one user: the default cap is 100 (plan 12q).
  const made =
    setups.get(database) ??
    adminApp({ ...database, limiter: { allow: async () => true } }, { sessionMaxPerUser: 1000 });
  setups.set(database, made);
  return made;
}

let operatorsMade = 0;

/**
 * One more platform operator through the product's flows, in the order of
 * adminApp. They are the sign-up, the mailed verify, the grant by the app,
 * the sign-in, and TOTP through Better Auth's two paths. It answers the user
 * id and the cookie of the session.
 */
export async function newOperator(a: Setup): Promise<{ id: string; cookie: string }> {
  operatorsMade++;
  const email = `operator-${operatorsMade}@example.com`;
  await a.call("/password/sign-up", { email, password: PASSWORD });
  await a.call("/password/verify", { token: a.links.at(-1) });
  const made = await a.auth.tempo.api.operator.createAdmin({
    actor: SETUP,
    email,
    reason: "Another operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  const cookie = cookieOf(await a.call("/password/sign-in", { email, password: PASSWORD }));
  const enable = await a.call("/two-factor/enable", { password: PASSWORD }, cookie);
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
  const confirm = await a.call(
    "/two-factor/verify-totp",
    { code: await totpCode(secret, new Date()) },
    cookie,
  );
  if (confirm.status !== 200) throw new Error(`verify-totp answered ${confirm.status}`);
  return { id: made.value.userId, cookie };
}

/** The cookies of `count` platform operators of the setup app. Each is made once per database. */
const operatorLists = new WeakMap<CompatDatabase, string[]>();
async function operatorsOf(database: CompatDatabase, count: number): Promise<string[]> {
  const a = await setupOf(database);
  const list = operatorLists.get(database) ?? [a.op];
  operatorLists.set(database, list);
  while (list.length < count) list.push((await newOperator(a)).cookie);
  return list.slice(0, count);
}

let targets = 0;

/**
 * A verified user with `own` sessions, then `imps` impersonation sessions,
 * through the shim's routes. The `operators` take turns at the starts. The
 * impersonation sessions sort last, because each id holds its time.
 * `cookies` holds the session cookie of each start, in the order of the starts.
 */
export async function impersonatedUser(
  database: CompatDatabase,
  own: number,
  imps: number,
  operators: number,
) {
  const a = await setupOf(database);
  const cookies = await operatorsOf(database, operators);
  targets++;
  const email = `target-${targets}@example.com`;
  // The sign-up's verify and the first sign-in open two sessions.
  const user = await a.user(email);
  for (let i = 2; i < own; i++) await a.call("/password/sign-in", { email, password: PASSWORD });
  await new Promise((r) => setTimeout(r, 5));
  const starts: string[] = [];
  for (let i = 0; i < imps; i++) {
    const start = await a.call(
      "/admin/impersonate-user",
      { userId: user.id },
      cookies[i % cookies.length] ?? "",
    );
    if (start.status !== 200) throw new Error(`impersonate-user answered ${start.status}`);
    starts.push(cookieOf(start));
  }
  const sessions = await database.storage.findMany(
    "session",
    [{ field: "userId", op: "eq", value: user.id }],
    { sort: { field: "id", dir: "asc" } },
  );
  return {
    setup: a,
    userId: user.id,
    sessions,
    impersonations: sessions.filter((r) => r.actorId !== null),
    cookies: starts,
  };
}

/** Every audit row of one target, oldest first, read by the app in pages of 100. */
export async function auditOf(a: Setup, targetUserId: string): Promise<OperatorAuditRow[]> {
  const all: OperatorAuditRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await a.auth.tempo.api.operator.audit.list({
      actor: SETUP,
      targetUserId,
      limit: 100,
      ...(after === undefined ? {} : { after }),
    });
    if (!page.ok) throw new Error(page.code);
    all.push(...page.value.rows);
    if (page.value.next === null) return all;
    after = page.value.next;
  }
}

/** The pending-end rows of one user. */
export function pendingOf(storage: StorageAdapter, userId: string) {
  return storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "session-end" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/**
 * Core on `storage` with the impersonation tool on, at the fixed time `at`.
 * `acted` takes each row that `operator.afterAction` gets.
 */
export function operatorEngine(storage: StorageAdapter, at: Date) {
  const acted: OperatorAuditRow[] = [];
  const { auth, ends } = engine(storage, [], {
    operator: { users: true, impersonation: { ttlMinutes: 60 } },
    clock: { now: () => new Date(at) },
    hooks: { operator: { afterAction: (e) => void acted.push(e.audit) } },
  });
  return { auth, ends, acted };
}

/** The suite of ruling 13 on one store. */
export function accountDeleteCascadeSuite(open: () => Promise<CascadeStore>): void {
  it("marks the storage: a user delete there cascades", async () => {
    const store = await open();
    expect(store.database.storage.userDeleteCascades).toBe(true);
  });

  for (const kind of ["self", "operator"] as const) {
    it(`deletes a solo owner by the ${kind} delete: each session ends with the hook, and no row stays`, async () => {
      const store = await open();
      const { me, organizationId } = await soloOwner(store, 3);
      const before = await rowsOf(store.database.storage, me.user.id, organizationId);
      expect(before).toEqual({
        user: true,
        sessions: 3,
        identities: 1,
        passwords: 0,
        members: 1,
        organization: true,
      });
      const act = store.act();
      const { auth, ends } = engine(act.storage, []);
      const answer =
        kind === "self"
          ? await auth.api.user.delete({ session: me, ip: null, userAgent: null })
          : await auth.api.operator.users.delete({
              actor: APP,
              userId: me.user.id,
              reason: "Ticket 1",
              ip: null,
              userAgent: null,
            });
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      expect(ends).toHaveLength(3);
      expect(await rowsOf(store.database.storage, me.user.id, organizationId)).toEqual({
        user: false,
        sessions: 0,
        identities: 0,
        passwords: 0,
        members: 0,
        organization: false,
      });
      const queries = act.queries();
      if (queries !== null) expect(queries).toBeLessThanOrEqual(50);
    });

    it(`keeps every row when the ${kind} delete refuses after the lock`, async () => {
      // A member joins the solo organization after the organization rule
      // read it, through the product's own add. The member delete then
      // matches two rows, and the act answers conflict.
      const store = await open();
      const { auth: setup, sent, me, organizationId } = await soloOwner(store, 3);
      const other = await signIn(setup, sent, `joiner${scenes}@example.com`);
      const before = await rowsOf(store.database.storage, me.user.id, organizationId);
      const act = store.act();
      let joined = false;
      const { auth, ends } = engine(act.storage, [], {
        hooks: {
          user: {
            beforeDelete: async () => {
              if (joined) return;
              joined = true;
              const added = await setup.api.addMember({
                user: me.user,
                organizationId,
                userId: other.user.id,
                role: "member",
              });
              if (!added.ok) throw new Error(added.code);
            },
          },
        },
      });
      const answer =
        kind === "self"
          ? await auth.api.user.delete({ session: me, ip: null, userAgent: null })
          : await auth.api.operator.users.delete({
              actor: APP,
              userId: me.user.id,
              reason: "Ticket 2",
              ip: null,
              userAgent: null,
            });
      expect(joined).toBe(true);
      expect(answer).toMatchObject({ ok: false, code: "conflict" });
      expect(ends).toEqual([]);
      expect(await rowsOf(store.database.storage, me.user.id, organizationId)).toEqual(before);
    });
  }

  it("removes through /admin/remove-user a member and a solo owner, or refuses the owner before any write", async () => {
    const store = await open();
    const a = await setupOf(store.database);
    const rowOf = async (id: string) => {
      const row = await store.database.storage.findOne("user", [
        { field: "id", op: "eq", value: id },
      ]);
      if (!row) throw new Error("no user");
      return row;
    };
    const organizationOf = async (id: string, slug: string) => {
      const made = await a.auth.tempo.api.createOrganization({
        user: await rowOf(id),
        slug,
        name: slug,
      });
      if (!made.ok) throw new Error(made.code);
      return made.value.organization.id;
    };
    const gone = {
      user: false,
      sessions: 0,
      identities: 0,
      passwords: 0,
      members: 0,
    };
    // Bea is a member of Cy's organization.
    const bea = await a.user("bea@example.com");
    const cy = await a.user("cy@example.com");
    const cyCo = await organizationOf(cy.id, "cy-co");
    const added = await a.auth.tempo.api.addMember({
      user: await rowOf(cy.id),
      organizationId: cyCo,
      userId: bea.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    expect(await rowsOf(store.database.storage, bea.id, cyCo)).toMatchObject({
      user: true,
      passwords: 1,
      members: 1,
    });
    const removedBea = await a.call("/admin/remove-user", { userId: bea.id }, a.op);
    expect([removedBea.status, await removedBea.json()]).toEqual([200, { success: true }]);
    expect(await rowsOf(store.database.storage, bea.id, cyCo)).toEqual({
      ...gone,
      organization: true,
    });
    // Ann owns her organization alone.
    const ann = await a.user("ann@example.com");
    const annCo = await organizationOf(ann.id, "ann-co");
    const before = await rowsOf(store.database.storage, ann.id, annCo);
    expect(before).toMatchObject({ user: true, passwords: 1, members: 1, organization: true });
    const removed = await a.call("/admin/remove-user", { userId: ann.id }, a.op);
    if (store.removeSolo === "too_large") {
      expect([removed.status, await removed.json()]).toEqual([
        409,
        { code: "DELETE_TOO_LARGE", message: "Delete too large" },
      ]);
      expect(await rowsOf(store.database.storage, ann.id, annCo)).toEqual(before);
      return;
    }
    expect([removed.status, await removed.json()]).toEqual([200, { success: true }]);
    expect(await rowsOf(store.database.storage, ann.id, annCo)).toEqual({
      ...gone,
      organization: false,
    });
  });

  it("records the impersonation sessions past the page, and the sweep writes their stop rows (decisions 3 and 5 of plan 12o)", {
    timeout: 600_000,
  }, async () => {
    // 501 own sessions, then 3 impersonation sessions of one operator. The
    // page ends `ownPage` own sessions, and the cascade takes the rest.
    const store = await open();
    const scene = await impersonatedUser(store.database, 501, 3, 1);
    expect(scene.sessions).toHaveLength(504);
    expect(scene.sessions.slice(-3)).toEqual(scene.impersonations);
    const at = new Date();
    const act = store.act();
    const { auth, ends } = operatorEngine(act.storage, at);
    const answer = await auth.api.operator.users.delete({
      actor: APP,
      userId: scene.userId,
      reason: "Ticket 4",
      ip: null,
      userAgent: null,
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    const queries = act.queries();
    if (queries !== null) expect(queries).toBeLessThanOrEqual(50);
    expect(ends).toHaveLength(store.ownPage ?? 500);
    expect((await rowsOf(store.database.storage, scene.userId, "none")).sessions).toBe(0);
    const stops = async () =>
      (await auditOf(scene.setup, scene.userId)).filter((r) => r.action === "impersonation_stop");
    expect(await stops()).toEqual([]);
    expect(
      (await pendingOf(store.database.storage, scene.userId)).map((r) => r.data?.stops),
    ).toEqual([scene.impersonations.map((r) => ({ sessionId: r.id, actorId: r.actorId }))]);
    // One sweep a minute later, in a new invocation.
    const later = new Date(at.getTime() + 60_000);
    const run = store.act();
    const sweep = operatorEngine(run.storage, later);
    await sweep.auth.api.sweepExpired();
    const swept = run.queries();
    if (swept !== null) expect(swept).toBeLessThanOrEqual(50);
    const rows = await stops();
    expect(
      rows.map((r) => ({
        actorId: r.actorId,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
      })),
    ).toEqual(
      scene.impersonations.map((r) => ({
        actorId: r.actorId,
        data: { sessionId: r.id, cause: "account_delete", endedAt: at.toISOString() },
        createdAt: later.toISOString(),
      })),
    );
    expect(sweep.acted.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(await pendingOf(store.database.storage, scene.userId)).toEqual([]);
  });

  it("leaves the rest of the owed stop rows on the row when one sweep cannot write them all, and the next sweep ends the row", {
    timeout: 600_000,
  }, async () => {
    // Review Focus 3 of plan 12o. 501 own sessions, then 40 impersonation
    // sessions of 2 operators. The cascade takes the 40 past the page, so the
    // row owes 40 stop rows. One sweep of 50 calls writes fewer.
    const store = await open();
    const scene = await impersonatedUser(store.database, 501, 40, 2);
    expect(scene.impersonations).toHaveLength(40);
    const at = new Date();
    const act = store.act();
    const { auth } = operatorEngine(act.storage, at);
    const answer = await auth.api.operator.users.delete({
      actor: APP,
      userId: scene.userId,
      reason: "Ticket 5",
      ip: null,
      userAgent: null,
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    const stops = async () =>
      (await auditOf(scene.setup, scene.userId)).filter((r) => r.action === "impersonation_stop");
    const owedOf = async () =>
      (await pendingOf(store.database.storage, scene.userId)).map((r) =>
        Array.isArray(r.data?.stops) ? r.data.stops.length : 0,
      );
    expect(await owedOf()).toEqual([40]);
    const written: number[] = [];
    let owed = 40;
    for (let i = 1; owed > 0 && i <= 5; i++) {
      const before = (await stops()).length;
      const run = store.act();
      const sweep = operatorEngine(run.storage, new Date(at.getTime() + i * 60_000));
      await sweep.auth.api.sweepExpired({ callBudget: 50 });
      const queries = run.queries();
      if (queries !== null) expect(queries).toBeLessThanOrEqual(50);
      const now = (await stops()).length - before;
      expect(sweep.acted.filter((r) => r.targetUserId === scene.userId)).toHaveLength(now);
      written.push(now);
      owed -= now;
      // A row that the sweep cannot finish stays with the rest of the list.
      expect(await owedOf()).toEqual(owed > 0 ? [owed] : []);
    }
    expect(written).toEqual([store.sweepStops, 40 - store.sweepStops]);
    const rows = await stops();
    expect(rows.map((r) => r.data?.sessionId).sort()).toEqual(
      scene.impersonations.map((r) => r.id).sort(),
    );
    expect(rows.map((r) => [r.data?.cause, r.data?.endedAt])).toEqual(
      rows.map(() => ["account_delete", at.toISOString()]),
    );
  });
}
