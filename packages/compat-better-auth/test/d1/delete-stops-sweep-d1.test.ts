import { applyD1Migrations, env } from "cloudflare:test";
import type { OperatorAuditRow } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import {
  auditOf,
  engine,
  impersonatedUser,
  newOperator,
  operatorEngine,
  pendingOf,
  rowsOf,
  setupOf,
} from "../account-delete-cascade-suite.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Decisions 3 to 5 of plan 12o on the D1 storage of the Better Auth tables.
// A user delete there cascades to the sessions. So the delete records the
// impersonation sessions that its page does not end, and the sweep writes
// their stop rows. Each delete and each sweep runs on a new storage over a
// counting binding. That is one invocation, with 50 queries or fewer (D1
// limits page updated 21 April 2026, read 2026-10-21).

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const database = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
const APP = { kind: "app", name: "support-tool" } as const;

/** A new storage over a counting binding: one invocation. */
function invocation() {
  const { db, count } = counting(env.DB);
  return { storage: betterAuthSchemaStorage({ dialect: "d1", db }).storage, count };
}

/** The app actor deletes the user at `at`, in one invocation. */
async function deleteAt(userId: string, at: Date) {
  const act = invocation();
  const e = operatorEngine(act.storage, at);
  const answer = await e.auth.api.operator.users.delete({
    actor: APP,
    userId,
    reason: "Ticket 12o-2",
    ip: null,
    userAgent: null,
  });
  return { answer, queries: act.count.queries, ends: e.ends, acted: e.acted };
}

/** One sweep with a budget of 50 at `at`, in one invocation. */
async function sweepAt(at: Date) {
  const run = invocation();
  const e = operatorEngine(run.storage, at);
  await e.auth.api.sweepExpired({ callBudget: 50 });
  return { queries: run.count.queries, acted: e.acted };
}

type Scene = Awaited<ReturnType<typeof impersonatedUser>>;

/** The rows of `acted` whose target is the user of `scene`. */
const ofScene = (acted: readonly OperatorAuditRow[], scene: Scene) =>
  acted.filter((r) => r.targetUserId === scene.userId);

/** The id of the first impersonation session of `scene`. */
const imp0 = (scene: Scene) => scene.impersonations[0]?.id;

/** The stop rows of the user of `scene`, oldest first. */
const stopsOf = async (scene: Scene) =>
  (await auditOf(scene.setup, scene.userId)).filter((r) => r.action === "impersonation_stop");

/** The count of the stop entries of each pending-end row of the user of `scene`. */
const owedOf = async (scene: Scene) =>
  (await pendingOf(database.storage, scene.userId)).map((r) =>
    Array.isArray(r.data?.stops) ? r.data.stops.length : 0,
  );

describe("the stop rows of a cascading delete on the compat D1 storage (decisions 3 to 5 of plan 12o)", () => {
  it("records 3 impersonation sessions past a page of 60 own sessions; one sweep writes their stop rows", {
    timeout: 120_000,
  }, async () => {
    const scene = await impersonatedUser(database, 60, 3, 1);
    expect(scene.sessions).toHaveLength(63);
    expect(scene.sessions.slice(-3)).toEqual(scene.impersonations);
    const at = new Date();
    const deleted = await deleteAt(scene.userId, at);
    expect(deleted.answer.ok, JSON.stringify(deleted.answer)).toBe(true);
    expect(deleted.queries).toBeLessThanOrEqual(50);
    expect((await rowsOf(database.storage, scene.userId, "none")).sessions).toBe(0);
    expect(await stopsOf(scene)).toEqual([]);
    expect(await owedOf(scene)).toEqual([3]);
    const later = new Date(at.getTime() + 60_000);
    const swept = await sweepAt(later);
    expect(swept.queries).toBeLessThanOrEqual(50);
    const stops = await stopsOf(scene);
    expect(
      stops.map((r) => ({
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
    // operator.afterAction ran once per stop row.
    expect(ofScene(swept.acted, scene).map((r) => r.id)).toEqual(stops.map((r) => r.id));
    expect(await pendingOf(database.storage, scene.userId)).toEqual([]);
    // Run of 2026-11-04: the queries of the delete, the own sessions that its page ended with
    // the hook, and the queries of the sweep.
    expect([deleted.queries, deleted.ends.length, swept.queries]).toEqual([47, 14, 26]);
  });

  it("writes the stop rows of 100 impersonation sessions of 5 operators over sweeps of 50 calls", {
    timeout: 300_000,
  }, async () => {
    const scene = await impersonatedUser(database, 2, 100, 5);
    expect(scene.impersonations).toHaveLength(100);
    const at = new Date();
    const deleted = await deleteAt(scene.userId, at);
    expect(deleted.answer.ok, JSON.stringify(deleted.answer)).toBe(true);
    expect(deleted.queries).toBeLessThanOrEqual(50);
    // The page ends some impersonation sessions with their stop rows, at the delete time.
    const inPage = (await stopsOf(scene)).length;
    expect(await owedOf(scene)).toEqual([100 - inPage]);
    // Each sweep writes the stop rows that fit, and leaves the rest on the row.
    const written: number[] = [];
    const queries: number[] = [];
    let owed = 100 - inPage;
    for (let i = 1; owed > 0 && i <= 10; i++) {
      const before = (await stopsOf(scene)).length;
      const swept = await sweepAt(new Date(at.getTime() + i * 60_000));
      expect(swept.queries).toBeLessThanOrEqual(50);
      queries.push(swept.queries);
      const now = (await stopsOf(scene)).length - before;
      expect(ofScene(swept.acted, scene)).toHaveLength(now);
      written.push(now);
      owed -= now;
      expect(await owedOf(scene)).toEqual(owed > 0 ? [owed] : []);
    }
    // Run of 2026-11-04: the queries of the delete and the stop rows of its page. Then the
    // stop rows of each sweep, and the queries of each sweep.
    expect([deleted.queries, inPage, ...written, ...queries]).toEqual([
      47, 6, 26, 26, 26, 16, 50, 50, 50, 39,
    ]);
    const stops = await stopsOf(scene);
    expect(stops.map((r) => r.data?.sessionId).sort()).toEqual(
      scene.impersonations.map((r) => r.id).sort(),
    );
    expect(new Set(stops.map((r) => r.actorId)).size).toBe(5);
    // The rows of the sweep hold the delete time.
    expect(stops.slice(inPage).every((r) => r.data?.endedAt === at.toISOString())).toBe(true);
  });

  it("refuses a delete of a user with 101 impersonation sessions with delete_too_large, and changes no row", {
    timeout: 300_000,
  }, async () => {
    const scene = await impersonatedUser(database, 2, 101, 5);
    expect(scene.sessions).toHaveLength(103);
    const state = async () => ({
      rows: await rowsOf(database.storage, scene.userId, "none"),
      audit: (await auditOf(scene.setup, scene.userId)).length,
      pending: await pendingOf(database.storage, scene.userId),
    });
    const before = await state();
    const deleted = await deleteAt(scene.userId, new Date());
    expect(deleted.answer).toMatchObject({ ok: false, code: "delete_too_large" });
    expect(deleted.queries).toBeLessThanOrEqual(50);
    // Run of 2026-11-04: the queries of the refused delete, with its undo.
    expect(deleted.queries).toBe(15);
    expect(deleted.acted).toEqual([]);
    expect(await state()).toEqual(before);
    expect(before.rows).toMatchObject({ user: true, sessions: 103 });
  });
  it("writes no stop row for an impersonation session that expired before the delete", {
    timeout: 120_000,
  }, async () => {
    // An expiry writes no stop row (spec 26 item 9). The delete comes one
    // minute after the expiry of the impersonation session, before any sweep.
    const scene = await impersonatedUser(database, 20, 1, 1);
    const [imp] = scene.impersonations;
    if (!imp) throw new Error("no impersonation session");
    const at = new Date(imp.expiresAt.getTime() + 60_000);
    const deleted = await deleteAt(scene.userId, at);
    expect(deleted.answer.ok, JSON.stringify(deleted.answer)).toBe(true);
    expect(deleted.queries).toBeLessThanOrEqual(50);
    // The own sessions past the page leave the row, with no stop entry.
    expect(await owedOf(scene)).toEqual([0]);
    await sweepAt(new Date(at.getTime() + 60_000));
    expect(await stopsOf(scene)).toEqual([]);
    expect(await pendingOf(database.storage, scene.userId)).toEqual([]);
  });

  it("writes the owed stop rows also when the sweep runs with the impersonation tool off", {
    timeout: 120_000,
  }, async () => {
    const scene = await impersonatedUser(database, 20, 1, 1);
    const at = new Date();
    const deleted = await deleteAt(scene.userId, at);
    expect(deleted.answer.ok, JSON.stringify(deleted.answer)).toBe(true);
    expect(await owedOf(scene)).toEqual([1]);
    const run = invocation();
    const acted: OperatorAuditRow[] = [];
    const later = new Date(at.getTime() + 60_000);
    const { auth } = engine(run.storage, [], {
      operator: { users: true },
      clock: { now: () => new Date(later) },
      hooks: { operator: { afterAction: (e) => void acted.push(e.audit) } },
    });
    await auth.api.sweepExpired();
    const stops = await stopsOf(scene);
    expect(stops.map((r) => r.data)).toEqual([
      { sessionId: imp0(scene), cause: "account_delete", endedAt: at.toISOString() },
    ]);
    expect(ofScene(acted, scene).map((r) => r.id)).toEqual(stops.map((r) => r.id));
    expect(await pendingOf(database.storage, scene.userId)).toEqual([]);
  });

  it("counts the read of the impersonation sessions in the size check of the delete", {
    timeout: 120_000,
  }, async () => {
    // An operator who impersonated a user and owns organizations with another
    // owner. The app actor deletes the operator. Each such organization costs
    // 3 calls, and the read 1. So 4 organizations answer delete_too_large, and
    // 3 fit in 50 queries.
    const a = await setupOf(database);
    const coOwner = await a.user("co-owner@example.com");
    const target = await a.user("impersonated@example.com");
    const operatorWith = async (owned: number) => {
      const op = await newOperator(a);
      const start = await a.call("/admin/impersonate-user", { userId: target.id }, op.cookie);
      expect(start.status).toBe(200);
      const user = await database.storage.findOne("user", [
        { field: "id", op: "eq", value: op.id },
      ]);
      if (!user) throw new Error("no operator row");
      for (let i = 0; i < owned; i++) {
        const made = await a.auth.tempo.api.createOrganization({
          user,
          slug: `owned-${op.id.toLowerCase()}-${i}`,
          name: `Owned ${i}`,
        });
        if (!made.ok) throw new Error(made.code);
        const added = await a.auth.tempo.api.addMember({
          user,
          organizationId: made.value.organization.id,
          userId: coOwner.id,
          role: "owner",
        });
        if (!added.ok) throw new Error(added.code);
      }
      return op.id;
    };
    const four = await operatorWith(4);
    const refused = await deleteAt(four, new Date());
    expect(refused.answer, `queries ${refused.queries}`).toMatchObject({
      ok: false,
      code: "delete_too_large",
    });
    expect(await rowsOf(database.storage, four, "none")).toMatchObject({ user: true, members: 5 });
    const three = await operatorWith(3);
    const deleted = await deleteAt(three, new Date());
    expect(deleted.answer.ok, JSON.stringify(deleted.answer)).toBe(true);
    expect(deleted.queries).toBeLessThanOrEqual(50);
    // Run of 2026-11-04: the queries of the refused delete and of the delete that fits.
    expect([refused.queries, deleted.queries]).toEqual([14, 47]);
  });
});
