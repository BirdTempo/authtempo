import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow } from "../../schema.js";
import { findManyIn, IN_CHUNK } from "../../storage/batch.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import { deliverLogouts } from "../oauth-logout.js";
import { writeLogouts } from "../oauth-outbox.js";
import { endAllAccess } from "../session-list.js";
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

/** The input of the end of one user's sessions. */
export interface EndUserSessionsInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/** The input of the end of all sessions. `limit` is 1 to 1000, default 500. */
export interface EndAllSessionsInput {
  actor: OperatorActor;
  reason: string;
  limit?: number;
  ip: string | null;
  userAgent: string | null;
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
 * Ends every session of one user (spec 26 item 5; ASVS 5.0.0 7.4.5:
 * "Verify that application administrators are able to terminate active
 * sessions for an individual user or for all users."). One transaction
 * holds the user row first (`holdUser`), then runs `endAllAccess`. It
 * ends every session, challenge, and handoff code of the user, and the
 * OAuth refresh tokens and codes. Then it writes the audit row with
 * `data: { ended }`. The API tokens stay: each has its own revoke. A user
 * actor ends their own sessions through the session list of plan 12a, so
 * their own user answers `operator_self`. A user actor gets
 * `operator_required` for a platform operator target.
 *
 * After the commit, in the order of ruling 2: `session.afterEnd` with
 * `operator` per session, the back-channel logouts, then `afterAction` and
 * `endFamilies` in `operatorAct`.
 */
export async function endUserSessions(
  config: ResolvedConfig,
  input: EndUserSessionsInput,
): Promise<Result<{ ended: number; auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
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
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, draft, ends) => {
      // The user row first: the lock order of every account write (user-hold.ts).
      await holdUser(tx, input.userId);
      // An ended row goes with no hook, as in the ban: it gets no `operator` event.
      await deleteEndedSessions(tx, config, input.userId, now);
      const ended = await endAllAccess(tx, input.userId, ends.ended ?? null, ends.families, now);
      // The row is the last write of the act, so it can hold the count.
      draft.data = { ended };
      return ok({ ended });
    },
    {
      async committed(_value, ends) {
        await sessionsEnded(config, ends.ended, "operator");
        await deliverLogouts(config, input.userId);
      },
    },
  );
  if (!done.ok) return done;
  return ok({ ended: done.value.ended, auditId: done.value.auditId });
}

/**
 * The storage calls of the work of one `endAllSessions` call: the read, the
 * link reads, the outbox writes, and the deletes (ruling 27 of plan 12f).
 * D1 allows 50 queries per invocation on Workers Free and 1000 on Workers
 * Paid (D1 limits page updated 21 April 2026, read 2026-10-20). The product
 * runs on Workers Free, so a call fits 50. The 5 calls that stay serve the
 * guard, the limiter, and the audit row.
 */
export const OPERATOR_CALL_BUDGET = 45;

/**
 * Ends a page of the listed session rows of any users in the caller's
 * transaction, inside `OPERATOR_CALL_BUDGET`. The read of `rows` was call
 * 1. Each chunk of `IN_CHUNK` rows costs one read of its client links.
 * Each session costs 2 calls per link: one `oauthLogout` row, due now, and
 * the delete of the link (plan 12e Task 16). With `ended` null (no
 * `session.afterEnd` hook), the chunk costs one delete by id. With a list,
 * each session costs one delete by id.
 *
 * Each step counts its calls before it runs. When the next session would
 * pass the budget, the page stops before it, so a session and its links
 * end together. The first session of a call always ends, so each call
 * ends one session or more. A session with 21 links or more then passes
 * the budget.
 *
 * A row goes to `ended` only when its delete count is 1 and it was live.
 * A sign-out between the read and the delete already fired its event
 * (final fix wave M-1). An expired row gets no event (plan 12a review L3).
 * The answer is the count of deleted rows, and `stopped` when the budget
 * left rows of the list.
 */
async function endSessionPage(
  tx: StorageAdapter,
  config: ResolvedConfig,
  rows: readonly SessionRow[],
  ended: SessionRow[] | null,
  now: Date,
): Promise<{ deleted: number; stopped: boolean }> {
  let used = 1;
  let taken = 0;
  let deleted = 0;
  for (let i = 0; i < rows.length; i += IN_CHUNK) {
    const chunk = rows.slice(i, i + IN_CHUNK);
    // The least next step: the link read and one delete.
    if (taken > 0 && used + 2 > OPERATOR_CALL_BUDGET) return { deleted, stopped: true };
    // The unique index (sessionId, clientId) leads with sessionId, so the read is by index.
    const links = await findManyIn(
      tx,
      "oauthSessionClient",
      "sessionId",
      chunk.map((r) => r.id),
    );
    used++;
    const take: SessionRow[] = [];
    let cost = ended ? 0 : 1;
    for (const row of chunk) {
      const own = links.filter((l) => l.sessionId === row.id).length;
      const next = 2 * own + (ended ? 1 : 0);
      if (taken + take.length > 0 && used + cost + next > OPERATOR_CALL_BUDGET) break;
      take.push(row);
      cost += next;
    }
    const ids = new Set(take.map((r) => r.id));
    await writeLogouts(
      tx,
      links.filter((l) => ids.has(l.sessionId)),
      now,
    );
    if (ended) {
      for (const row of take)
        if ((await tx.delete("session", [{ field: "id", op: "eq", value: row.id }])) === 1) {
          deleted++;
          if (sessionIsLive(config, row, now)) ended.push(row);
        }
    } else if (take.length > 0) {
      deleted += await tx.delete("session", [{ field: "id", op: "in", value: [...ids] }]);
    }
    used += cost;
    taken += take.length;
    if (take.length < chunk.length) return { deleted, stopped: true };
  }
  return { deleted, stopped: false };
}

/**
 * Ends the sessions of all users, one page per call (spec 26 item 5;
 * ASVS 5.0.0 7.4.5). One transaction reads `limit + 1` session rows by
 * `id` ascending, never the session of a user actor. It ends the first
 * `limit` rows, or fewer when `OPERATOR_CALL_BUDGET` stops the page
 * (`endSessionPage`). Then it writes one audit row with
 * `targetUserId: null` and `data: { ended }`. The answer has `more: true`
 * when rows stay, and the caller calls again. An ended row is gone, so the
 * next read starts at the first row that stays, and no row ends twice.
 *
 * It ends the sessions only. The challenges, the handoff codes, and the
 * OAuth tokens of every user stay; `endUserSessions` ends them for one
 * user. The links of the ended sessions become outbox rows that are due
 * now, and the sweep sends them (ruling 1). A call sends none, because
 * 500 users can mean 5000 HTTP calls in one request. It holds no user
 * row: a hold costs calls per user, and the page touches only the session
 * and link rows, so it waits on no user row that another flow holds.
 *
 * The cost of a page of n sessions with L client links has five parts.
 * They are 1 read, ceil(n / 50) link reads, 2 calls per link, the
 * deletes, and the audit row. With no hook the deletes are ceil(n / 50)
 * statements. The sum is 2 + 2 ceil(n / 50) + 2L: 22 for 500 sessions
 * with no link, and 42 for 1000. With a `session.afterEnd` hook there is
 * one delete per session, and the sum is 2 + ceil(n / 50) + n + 2L. The
 * budget holds the sum less the audit row at 45 or less, so a page with a
 * hook ends about 43 sessions with no link. D1 allows 50 queries per
 * invocation on Workers Free and 1000 on Workers Paid (D1 limits page
 * updated 21 April 2026, read 2026-10-20). A call fits both.
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
      const read = await tx.findMany("session", keep, {
        sort: { field: "id", dir: "asc" },
        limit: limit + 1,
      });
      const page = await endSessionPage(tx, config, read.slice(0, limit), ends.ended ?? null, now);
      // The row is the last write of the act, so it can hold the count.
      draft.data = { ended: page.deleted };
      return ok({ ended: page.deleted, more: page.stopped || read.length > limit });
    },
    { committed: (_value, ends) => sessionsEnded(config, ends.ended, "operator") },
  );
  if (!done.ok) return done;
  return ok({ ended: done.value.ended, more: done.value.more, auditId: done.value.auditId });
}
