import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow } from "../../schema.js";
import { findManyIn, IN_CHUNK } from "../../storage/batch.js";
import { meterOf } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import { deleteOAuthCodes } from "../oauth-grants.js";
import { writeLogouts } from "../oauth-outbox.js";
import { deleteTwoFactorChallenges } from "../second-factor.js";
import { deleteHandoffCodes } from "../session-list.js";
import { deleteEndedSessions, sessionIsLive, sessionsEnded } from "../sessions.js";
import { holdUser } from "../user-hold.js";
import { auditDraft, operatorAct, operatorReason } from "./audit.js";
import { targetOf } from "./ban.js";
import { type OperatorActor, requireScope } from "./guards.js";

/**
 * The session rows of one call of `endAllSessions`: 500 by default, at
 * most 1000 (spec 26 item 5). One call stays inside the CPU limit of a
 * Worker; the CLI calls again until more is false, as secret rewrap does
 * (plan 11c2).
 */
export const END_ALL_LIMIT = { default: 500, max: 1000 };

/**
 * The input of the end of one user's sessions. `callsUsed` is the count of
 * storage calls of the invocation before this call, default
 * `OPERATOR_CALLS_BEFORE` of the actor.
 */
export interface EndUserSessionsInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  callsUsed?: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The input of the end of all sessions. `limit` is 1 to 1000, default 500.
 * `callsUsed` is the count of storage calls of the invocation before this
 * call, default `OPERATOR_CALLS_BEFORE` of the actor.
 */
export interface EndAllSessionsInput {
  actor: OperatorActor;
  reason: string;
  limit?: number;
  callsUsed?: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The answer of the end of one user's sessions. `familyEndFailed` is set
 * when `endFamilies` threw after the commit; `more` is then true.
 */
export interface EndUserSessionsAnswer {
  ended: number;
  more: boolean;
  auditId: string;
  familyEndFailed?: true;
}

/** The first checks, in order: the tool is on, the actor holds the scope `sessions`, and the reason is valid. */
function reasonOf(
  config: ResolvedConfig,
  input: { actor: OperatorActor; reason: unknown },
): Result<string> {
  if (!config.operator?.users) return fail("not_found");
  const scoped = requireScope(input.actor, "sessions");
  if (!scoped.ok) return scoped;
  return operatorReason(input.reason);
}

/**
 * The worst case of each step of `endUserSessions` in D1 statements, for an
 * adapter with no `statementsSent`. Each number is the count of the D1 test
 * `operator-sessions-budget.test.ts`. The hold is a read and a batch of 2.
 * The expired rows are the lock read of `lockInOrder` and 2 deletes.
 */
const STEP_WORST = { hold: 3, expired: 3 } as const;

/** The calls of `targetOf`: the user, and for a user actor the platform organization and the member row. */
const TARGET_CALLS: Readonly<Record<OperatorActor["kind"], number>> = {
  user: 3,
  secret: 1,
  app: 1,
};

/**
 * The calls that the last page of `endUserSessions` keeps for its own
 * steps: the delete of a session that a sign-in wrote after the read, the
 * read of the refresh tokens, their delete, the 2 statements of
 * `deleteOAuthCodes`, and the read of `endFamilies` after the commit. Then
 * one family at the least: 2 calls of `revokeFamily`.
 */
const LAST_PAGE_CALLS = 6;
const FAMILY_CALLS = 2;

/**
 * Ends the access of one user, one page per call (spec 26 item 5; ASVS
 * 5.0.0 7.4.5: "Verify that application administrators are able to
 * terminate active sessions for an individual user or for all users.").
 * A user actor ends their own sessions through the session list of plan
 * 12a, so their own user answers `operator_self`. A user actor gets
 * `operator_required` for a platform operator target. The API tokens
 * stay: each has its own revoke.
 *
 * Each call fits `OPERATOR_CALL_BUDGET` with the calls before it, as
 * `endAllSessions` does (ruling 34 of plan 12f). One transaction holds the
 * user row first (`holdUser`, the lock order of every account write). Then
 * it deletes the challenges, the expired sessions with no hook, a page of
 * the live sessions by id (`endSessionPage`), and the handoff codes. That
 * is the order of `endAllAccess`. When no session stays, the same call
 * deletes the refresh tokens of as many OAuth families as the calls left
 * allow, and the OAuth codes. The audit row holds `data: { ended }`.
 * `more` is true while sessions or families stay, and the caller calls
 * again. The calls of `endFamilies` after the commit are in the budget. A
 * throw there still answers ok, with `familyEndFailed: true` and `more`
 * true (ruling 37). The next call reads the user's refresh tokens again.
 * It ends the family of each row that a parallel exchange wrote.
 *
 * After the commit, in the order of ruling 2: `session.afterEnd` with
 * `operator` per session, then `afterAction` and `endFamilies` in
 * `operatorAct`. The call sends no back-channel logout: its outbox rows
 * are due now, and the sweep sends them (ruling 37 of plan 12f). So the
 * cost of a call does not depend on a signature, a reseal, or a key
 * rotation. The work counts its statements with `meterOf`.
 */
export async function endUserSessions(
  config: ResolvedConfig,
  input: EndUserSessionsInput,
): Promise<Result<EndUserSessionsAnswer>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const fixed = TARGET_CALLS[input.actor.kind];
  // The least call: the target, the hold (3), the challenges, the lock and the expired rows (3 at
  // most), the read, and the handoff codes (6), a page of one session (2 more), and the last page.
  const budget = await workBudget(
    config.storage,
    input.actor,
    input.callsUsed,
    fixed + 3 + 6 + 2 + LAST_PAGE_CALLS + FAMILY_CALLS,
  );
  if (!budget.ok) return budget;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const drafted = auditDraft(input.actor, {
    action: "sessions_end_user",
    targetUserId: input.userId,
    reason: reason.value,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const now = config.clock.now();
  const userId = input.userId;
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, draft, ends) => {
      const meter = meterOf(tx, fixed);
      // The user row first: the lock order of every account write (user-hold.ts).
      await holdUser(tx, userId);
      meter.step(STEP_WORST.hold);
      // A challenge first, as in endAllAccess: a verify spends its challenge as its last statement.
      await deleteTwoFactorChallenges(tx, userId);
      meter.step(1);
      // An ended row goes with no hook, as in the ban: it gets no `operator` event.
      await deleteEndedSessions(tx, config, userId, now);
      meter.step(STEP_WORST.expired);
      const read = await tx.findMany("session", [{ field: "userId", op: "eq", value: userId }], {
        sort: { field: "id", dir: "asc" },
        limit: END_ALL_LIMIT.default + 1,
      });
      meter.step(1);
      const rows = read.slice(0, END_ALL_LIMIT.default);
      // The page counts its read again, so it gets 1 more; the handoff delete and the last page stay out.
      const pageBudget = budget.value - meter.used + 1 - 1 - LAST_PAGE_CALLS - FAMILY_CALLS;
      // No lock of its own: deleteEndedSessions took the locks of every session of the user.
      const page = await endSessionPage(
        tx,
        config,
        rows,
        ends.ended ?? null,
        now,
        pageBudget,
        null,
      );
      meter.step(page.used - 1);
      await deleteHandoffCodes(tx, userId);
      meter.step(1);
      const sessionsLeft = page.stopped || read.length > rows.length;
      let familiesLeft = false;
      let late = 0;
      if (!sessionsLeft) {
        // A sign-in that commits after the read loses its row here, with no hook (plan 9d).
        late = await tx.delete("session", [{ field: "userId", op: "eq", value: userId }]);
        const tokens = await tx.findMany(
          "oauthToken",
          [{ field: "userId", op: "eq", value: userId }],
          {
            sort: { field: "id", dir: "asc" },
          },
        );
        meter.step(2);
        const all = [...new Set(tokens.map((t) => t.familyId))];
        // The calls left after the token delete, the codes, and the read of endFamilies.
        const room = Math.floor((budget.value - meter.used - 4) / FAMILY_CALLS);
        const take = all.slice(0, Math.min(room, IN_CHUNK));
        if (take.length > 0) {
          // The last families take the whole user, so the read of endFamilies
          // after the commit also finds a family that a parallel exchange wrote.
          const where: Where<"oauthToken">[] = [
            { field: "userId", op: "eq", value: userId },
            ...(take.length < all.length
              ? [{ field: "familyId" as const, op: "in" as const, value: take }]
              : []),
          ];
          for (const id of take) ends.families.ids.add(id);
          ends.families.scopes.push(where);
          await tx.delete("oauthToken", where);
          meter.step(1);
        }
        await deleteOAuthCodes(tx, userId);
        meter.step(2);
        familiesLeft = take.length < all.length;
      }
      // The row is the last write of the act, so it can hold the count.
      draft.data = { ended: page.deleted + late };
      return ok({ ended: page.deleted + late, more: sessionsLeft || familiesLeft });
    },
    {
      committed: (_value, ends) => sessionsEnded(config, ends.ended, "operator"),
      answerFamilyEnd: true,
    },
  );
  if (!done.ok) return done;
  const { ended, more, auditId, familyEndFailed } = done.value;
  return ok(
    familyEndFailed ? { ended, more: true, auditId, familyEndFailed } : { ended, more, auditId },
  );
}

/**
 * The storage calls of one whole invocation that holds a session call:
 * the calls before it and the call itself (ruling 34 of plan 12f). D1
 * allows 50 queries per invocation on Workers Free and 1000 on Workers
 * Paid (D1 limits page updated 21 April 2026, read 2026-10-21). The
 * product runs on Workers Free, so the whole invocation fits 50. Each
 * statement of a D1 batch counts as one call here.
 */
export const OPERATOR_CALL_BUDGET = 50;

/**
 * The worst case of D1 statements before a session call, for each actor
 * (rulings 34, 35, and 37 of plan 12f). It holds when the caller passes no
 * `callsUsed`, and it leaves out the ready check. A user actor through
 * the route costs 8. The route limiter is 1. `resolveSession` is 3: the
 * session, the user, and the sliding refresh. `requireOperatorUser` is 4:
 * the platform organization, the member row, the second factor, and its
 * limiter. The app: none. A secret actor: the limiter per IP and the
 * limiter per secret (ruling 38); the route test counts these 2. The
 * adapter's `statementsSent` cannot give these: an
 * app keeps one adapter for many invocations, and the limiter queries go
 * to the binding. A caller that made more calls passes its count as
 * `callsUsed`.
 *
 * The ready check comes on top: `readyStatements` of the storage, or 1
 * when the storage has none. The check of a core D1 adapter is 1 query.
 * The check of the D1 storage of the Better Auth tables is 4 or more.
 * The D1 tests count each whole invocation on the binding: 9 before a
 * user-actor call on core D1 (`operator-sessions-budget.test.ts`).
 */
export const OPERATOR_CALLS_BEFORE: Readonly<Record<OperatorActor["kind"], number>> = {
  user: 8,
  secret: 2,
  app: 0,
};

/**
 * The calls that the work of a session call may make: the budget less the
 * calls before the act and the audit row. `callsUsed` is the count of the
 * caller, an integer from 0 to 49, else `invalid_body`. With no
 * `callsUsed`, the calls before are `OPERATOR_CALLS_BEFORE` of the actor
 * and the ready check of the storage. The answer is `invalid_body` too
 * when the work would get fewer than `least` calls.
 */
async function workBudget(
  storage: StorageAdapter,
  actor: OperatorActor,
  callsUsed: unknown,
  least: number,
): Promise<Result<number>> {
  const before =
    callsUsed === undefined
      ? OPERATOR_CALLS_BEFORE[actor.kind] + ((await storage.readyStatements?.()) ?? 1)
      : callsUsed;
  if (
    typeof before !== "number" ||
    !Number.isInteger(before) ||
    before < 0 ||
    before >= OPERATOR_CALL_BUDGET
  )
    return fail("invalid_body");
  // The audit row is the last call of the act.
  const work = OPERATOR_CALL_BUDGET - before - 1;
  return work < least ? fail("invalid_body") : ok(work);
}

/**
 * Ends a page of the listed session rows of any users in the caller's
 * transaction, inside `budget` storage calls. The read of `rows` was call
 * 1. Each chunk of `IN_CHUNK` rows costs one read of its client links.
 * With `ended` null (no `session.afterEnd` hook), each chunk costs one
 * delete by id. With a list, each session costs one delete by id.
 *
 * The sessions come first (ruling 34 of plan 12f). The page takes the
 * most rows whose link reads and deletes fit the budget, and one row
 * at the least. Then each link costs 2 calls: one `oauthLogout` row, due
 * now, and the delete of the link (plan 12e Task 16). The links that fit
 * the calls left get their rows, by link id. The other links stay with no
 * session, and the sweep step `sweepLinks` makes their logouts (ruling 49
 * of plan 12e). So a session ends in its call, whatever its count of links.
 *
 * In the transaction the link writes come before the session deletes, and
 * each step takes its rows by id. That is the order of `endSessions`, so
 * the page and a ban of a user take the rows in one order on Postgres.
 *
 * A row goes to `ended` only when its delete count is 1 and it was live.
 * A sign-out between the read and the delete already fired its event
 * (final fix wave M-1). An expired row gets no event (plan 12a review L3).
 * The answer is the count of deleted rows, `stopped` when the budget left
 * rows of the list, and `used`, the calls of the page.
 */
async function endSessionPage(
  tx: StorageAdapter,
  config: ResolvedConfig,
  rows: readonly SessionRow[],
  ended: SessionRow[] | null,
  now: Date,
  budget: number,
  lock: Where<"session">[] | null,
): Promise<{ deleted: number; stopped: boolean; used: number }> {
  const chunks = (k: number) => Math.ceil(k / IN_CHUNK);
  // The read, the lock, the link reads, and the deletes of the first k rows.
  const cost = (k: number) => 1 + (lock ? 1 : 0) + chunks(k) + (ended ? k : chunks(k));
  let k = rows.length;
  while (k > 1 && cost(k) > budget) k--;
  const take = rows.slice(0, k);
  const first = take[0];
  const last = take.at(-1);
  // The row locks of the page first, by id, in one statement (ruling 36 of plan 12f).
  if (lock && first && last)
    await tx.lockInOrder?.("session", [
      ...lock,
      { field: "id", op: "gte", value: first.id },
      { field: "id", op: "lte", value: last.id },
    ]);
  // The unique index (sessionId, clientId) leads with sessionId, so each read is by index.
  const links = await findManyIn(
    tx,
    "oauthSessionClient",
    "sessionId",
    take.map((r) => r.id),
  );
  let used = cost(k);
  const room = Math.max(0, Math.floor((budget - used) / 2));
  const written = [...links]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, room);
  await writeLogouts(tx, written, now);
  used += 2 * written.length;
  let deleted = 0;
  if (ended) {
    for (const row of take)
      if ((await tx.delete("session", [{ field: "id", op: "eq", value: row.id }])) === 1) {
        deleted++;
        if (sessionIsLive(config, row, now)) ended.push(row);
      }
  } else {
    for (let i = 0; i < take.length; i += IN_CHUNK) {
      const ids = take.slice(i, i + IN_CHUNK).map((r) => r.id);
      deleted += await tx.delete("session", [{ field: "id", op: "in", value: ids }]);
    }
  }
  return { deleted, stopped: k < rows.length, used };
}

/**
 * Ends the sessions of all users, one page per call (spec 26 item 5;
 * ASVS 5.0.0 7.4.5). One transaction reads `limit + 1` session rows by
 * `id` ascending, never the session of a user actor. It ends the first
 * `limit` rows, or fewer when the budget stops the page (`endSessionPage`).
 * The budget is `OPERATOR_CALL_BUDGET` less the calls before the act and
 * the audit row. Then it writes one audit row with
 * `targetUserId: null` and `data: { ended }`. The answer has `more: true`
 * when rows stay, and the caller calls again. An ended row is gone, so the
 * next read starts at the first row that stays, and no row ends twice.
 *
 * It ends the sessions only. The challenges, the handoff codes, and the
 * OAuth tokens of every user stay; `endUserSessions` ends them for one
 * user. The links of the ended sessions become outbox rows that are due
 * now, as far as the budget allows, and the sweep makes the rest. The
 * sweep sends them all (ruling 1). A call sends none, because
 * 500 users can mean 5000 HTTP calls in one request. It holds no user
 * row: a hold costs calls per user, and the page touches only the session
 * and link rows, so it waits on no user row that another flow holds.
 *
 * The cost of a page of n sessions has five parts: 1 read, the lock read
 * of `lockInOrder`, ceil(n / 50) link reads, the deletes, and the audit
 * row. With no hook the deletes are ceil(n / 50) statements, so the sum is
 * 3 + 2 ceil(n / 50): 23 for 500 sessions, and 43 for 1000. With a
 * `session.afterEnd` hook there is one delete per session, and the sum is
 * 3 + ceil(n / 50) + n. D1 has no row lock and sends 1 less. The calls
 * left write the logouts of the client links, 2 calls per link, and the
 * sweep logs out the rest. The work gets 48 calls for the app, 46 for a
 * secret, and 40 for a user actor, so a page with a hook ends 45, 43, or
 * 37 sessions. A call fits D1 Free, and so it fits Workers Paid too.
 */
export async function endAllSessions(
  config: ResolvedConfig,
  input: EndAllSessionsInput,
): Promise<Result<{ ended: number; more: boolean; auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const limit = input.limit ?? END_ALL_LIMIT.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > END_ALL_LIMIT.max)
    return fail("invalid_body");
  // The least page: the read, the lock, one link read, and one delete.
  const budget = await workBudget(config.storage, input.actor, input.callsUsed, 4);
  if (!budget.ok) return budget;
  const drafted = auditDraft(input.actor, {
    action: "sessions_end_all",
    targetUserId: null,
    reason: reason.value,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const actor = input.actor;
  const keep: Where<"session">[] =
    actor.kind === "user" ? [{ field: "id", op: "ne", value: actor.session.id }] : [];
  const now = config.clock.now();
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, draft, ends) => {
      const meter = meterOf(tx, 0);
      const read = await tx.findMany("session", keep, {
        sort: { field: "id", dir: "asc" },
        limit: limit + 1,
      });
      meter.step(1);
      // The page counts the read as its call 1.
      const page = await endSessionPage(
        tx,
        config,
        read.slice(0, limit),
        ends.ended ?? null,
        now,
        budget.value - meter.used + 1,
        keep,
      );
      // The row is the last write of the act, so it can hold the count.
      draft.data = { ended: page.deleted };
      return ok({ ended: page.deleted, more: page.stopped || read.length > limit });
    },
    { committed: (_value, ends) => sessionsEnded(config, ends.ended, "operator") },
  );
  if (!done.ok) return done;
  return ok({ ended: done.value.ended, more: done.value.more, auditId: done.value.auditId });
}
