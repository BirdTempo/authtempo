import type { ResolvedConfig } from "../../config.js";
import { sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import type { SessionRow, VerificationRow } from "../../schema.js";
import type { Meter } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import type { SessionEndReason } from "../hooks.js";
import { deleteOAuthCodes } from "../oauth-grants.js";
import { deleteTwoFactorChallenges } from "../second-factor.js";
import { deleteHandoffCodes } from "../session-list.js";
import { deleteEndedSessions, endedList, sessionsEnded } from "../sessions.js";
import {
  type ImpersonationStops,
  impersonationStops,
  type OperatorActEnds,
  type StopCause,
} from "./audit.js";
import type { ImpersonationHold } from "./impersonation.js";
import { END_ALL_LIMIT, endSessionPage, FAMILY_CALLS, STEP_WORST } from "./sessions.js";

/**
 * The end of all access of one user by a ban or a revoke of the platform
 * role (ruling 44 of plan 12f). It stays inside the call budget. The act
 * ends a page of the sessions in its transaction. The sessions that do not
 * fit stay, with one pending-end row, and the sweep ends them
 * (`sweepPendingEnds`). Until then each door refuses such a row. For a ban
 * the door is `bannedFor`. For a revoke it is the live read of the
 * platform role at each operator check. An account delete of an operator
 * and a role loss leave only impersonation sessions, and their door is
 * `impersonationLoss` (ruling 63).
 */

/**
 * The `session.afterEnd` reason of the sessions that a pending-end row
 * names. `banned` and `operator` come from a ban and a revoke.
 * `account_deleted` and `impersonation_end` come from an account delete
 * and a role loss of an operator (ruling 63 of plan 12f). Those two rows
 * name only impersonation sessions.
 */
export type PendingEndReason = Extract<
  SessionEndReason,
  "banned" | "operator" | "account_deleted" | "impersonation_end"
>;

/** The cause of the stop row of an impersonation session that a pending-end row ends. */
const PENDING_STOP_CAUSE: Readonly<Record<PendingEndReason, Exclude<StopCause, "stop">>> = {
  banned: "ban",
  operator: "revoke",
  account_deleted: "account_delete",
  impersonation_end: "role_loss",
};

/** The reason of a pending-end row. A row with no known reason is a ban, as before ruling 63. */
function pendingReason(value: unknown): PendingEndReason {
  return typeof value === "string" && Object.hasOwn(PENDING_STOP_CAUSE, value)
    ? (value as PendingEndReason)
    : "banned";
}

/**
 * The life of a pending-end row: 3650 days, far past the life of any
 * session. The sweep deletes the row when its work is done, so the row
 * never expires before that. The first sweep step deletes the expired
 * verification rows, so a short life could drop a row with work left.
 */
export const PENDING_END_MS = 3650 * 86_400_000;

/**
 * The calls of the last steps of `endAllAccessPage`. They are the handoff
 * codes, the delete of the refresh tokens, and the 2 statements of
 * `deleteOAuthCodes`. Then comes the pending-end row or the delete of a
 * late session.
 */
const TAIL_CALLS = 5;

/** The least page: the read of the sessions, one link read, and one delete. */
const PAGE_LEAST = 3;

/**
 * The least calls of the work of a ban or a revoke after its own write.
 * They are the expired rows (3), the challenges, the token read, and the
 * session read. Then come the last steps, and the read of `endFamilies`
 * after the commit.
 */
export const ACCESS_END_LEAST = STEP_WORST.expired + 3 + TAIL_CALLS + 1;

/**
 * Ends the access of one user in the act's transaction, inside `budget`
 * calls of `meter` (rulings 37 and 44 of plan 12f). The order is the order
 * of every session end. First come the expired sessions with no hook, the
 * challenges, and a page of the live sessions by id (`endSessionPage`).
 * Then come the handoff codes, then the OAuth refresh tokens and codes.
 * The API tokens stay (spec 26 item 6).
 *
 * The refresh tokens all go in the act. The read of the tokens comes
 * first, so the page keeps the calls of `endFamilies` after the commit:
 * one read, and 2 calls per family. The page gets the calls that stay.
 * When sessions stay, the act writes one pending-end row, and the sweep
 * ends them. With no session left, a last delete takes a session that a
 * sign-in wrote after the read, with no hook (plan 9d).
 *
 * The answer is the count of ended sessions, and `left` when sessions stay.
 */
export async function endAllAccessPage(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  ends: OperatorActEnds,
  now: Date,
  meter: Meter,
  budget: number,
  reason: PendingEndReason,
  stops: ImpersonationStops | null,
): Promise<{ ended: number; left: boolean }> {
  const byUser: Where<"session">[] = [{ field: "userId", op: "eq", value: userId }];
  // The locks of every session of the user first, then the ended rows with no hook (plan 12a review L3).
  await deleteEndedSessions(tx, config, userId, now);
  meter.step(STEP_WORST.expired);
  // A verify spends its challenge as its last statement, so the challenges go first (plan 9f).
  await deleteTwoFactorChallenges(tx, userId);
  meter.step(1);
  const tokenWhere: Where<"oauthToken">[] = [{ field: "userId", op: "eq", value: userId }];
  const tokens = await tx.findMany("oauthToken", tokenWhere, { sort: { field: "id", dir: "asc" } });
  meter.step(1);
  const families = new Set(tokens.map((t) => t.familyId));
  const afterCommit = 1 + FAMILY_CALLS * families.size;
  const read = await tx.findMany("session", byUser, {
    sort: { field: "id", dir: "asc" },
    limit: END_ALL_LIMIT.default + 1,
  });
  meter.step(1);
  const rows = read.slice(0, END_ALL_LIMIT.default);
  // The page counts its read again, so it gets 1 more.
  const pageBudget = budget - meter.used + 1 - TAIL_CALLS - afterCommit;
  // No lock of its own: deleteEndedSessions took the locks of every session of the user.
  const page =
    rows.length > 0 && pageBudget >= PAGE_LEAST
      ? await endSessionPage(tx, config, rows, ends.ended ?? null, now, pageBudget, null, stops)
      : { deleted: 0, stopped: rows.length > 0, used: 1 };
  meter.step(page.used - 1);
  await deleteHandoffCodes(tx, userId);
  meter.step(1);
  for (const id of families) ends.families.ids.add(id);
  ends.families.scopes.push(tokenWhere);
  await tx.delete("oauthToken", tokenWhere);
  meter.step(1);
  await deleteOAuthCodes(tx, userId);
  meter.step(2);
  const left = page.stopped || read.length > rows.length;
  if (left) await writePendingEnd(tx, config, userId, reason);
  // A sign-in that commits after the read loses its row here, with no hook (plan 9d).
  else await tx.delete("session", byUser);
  meter.step(1);
  return { ended: page.deleted, left };
}

/**
 * Ends the impersonation sessions that the operator of `hold` opened, inside
 * `budget` calls of `meter` (rulings 31, 44, and 63 of plan 12f). Every loss
 * of the platform role calls it in its transaction: the ban, the revoke,
 * the account delete, and a removal, a leave, or a role change of the
 * platform member row. One read by the `userId` index takes the sessions,
 * and a page ends them with their stop rows (`endSessionPage`). The page
 * keeps `keep` calls for the steps of the caller after it, and one call for
 * the pending-end row. The rows that do not fit stay with a pending-end row
 * that names the operator and the targets, and the sweep ends them. Until
 * then the door of each session read refuses them (`impersonationLoss`).
 * The answer is true when rows stay.
 */
export async function endImpersonationsPage(
  tx: StorageAdapter,
  config: ResolvedConfig,
  hold: ImpersonationHold,
  ended: SessionRow[] | null,
  now: Date,
  meter: Meter,
  budget: number,
  keep: number,
  reason: PendingEndReason,
  stops: ImpersonationStops | null,
): Promise<boolean> {
  if (hold.targets.length === 0) return false;
  const where = impersonationWhere(hold.operatorId, hold.targets);
  const read = await tx.findMany("session", where, {
    sort: { field: "id", dir: "asc" },
    limit: END_ALL_LIMIT.default + 1,
  });
  meter.step(1);
  if (read.length === 0) return false;
  const rows = read.slice(0, END_ALL_LIMIT.default);
  // The page counts its read again, so it gets 1 more. The calls of the caller and the row stay out.
  const pageBudget = budget - meter.used + 1 - keep - 1;
  // No lock of its own: holdImpersonations took the locks of these rows.
  const page =
    pageBudget >= PAGE_LEAST
      ? await endSessionPage(tx, config, rows, ended, now, pageBudget, null, stops)
      : { deleted: 0, stopped: true, used: 1 };
  meter.step(page.used - 1);
  const left = page.stopped || read.length > rows.length;
  if (left) {
    await writePendingEnd(tx, config, hold.operatorId, reason, hold.targets);
    meter.step(1);
  }
  return left;
}

/** The calls that a ban or a revoke keeps after `endImpersonationsPage`: the own sessions of the user. */
export const ACCESS_END_KEEP = ACCESS_END_LEAST + PAGE_LEAST;

/** The impersonation sessions of `operatorId` on `targets`: by the `userId` index. */
function impersonationWhere(operatorId: string, targets: readonly string[]): Where<"session">[] {
  return [
    { field: "userId", op: "in", value: [...targets] },
    { field: "actorId", op: "eq", value: operatorId },
  ];
}

/**
 * The pending-end row of a user, in the act's transaction: a verification
 * row with the purpose `session-end`. `data.before` is the time of the
 * write, so the sweep ends only the sessions from before the act, never a
 * sign-in after it. With `targets`, the row names the impersonation
 * sessions that the user opened as an operator: the sessions of those
 * users whose `actorId` is the user. The sweep never reads the audit
 * table, so the row holds the ids.
 */
async function writePendingEnd(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  reason: PendingEndReason,
  targets?: readonly string[],
): Promise<void> {
  const now = config.clock.now();
  const id = newId(now);
  await tx.create("verification", {
    id,
    purpose: "session-end",
    identifier: userId,
    // No code: the hash of the id fills the unique key.
    valueHash: await sha256Hex(`session-end:${id}`),
    expiresAt: new Date(now.getTime() + PENDING_END_MS),
    consumedAt: null,
    data:
      targets === undefined
        ? { reason, before: now.toISOString() }
        : { reason, before: now.toISOString(), targets: [...targets] },
    secretVersion: config.keyring.current,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * True when a pending-end row of the user's own sessions exists: a revoke
 * after a revoke reads it (ruling 45). Only a ban or a revoke writes such
 * a row. A row with `data.targets` names the impersonation sessions of a
 * role loss, so it does not count (ruling 65 of plan 12f).
 */
export async function hasPendingEnd(tx: StorageAdapter, userId: string): Promise<boolean> {
  const rows = await tx.findMany("verification", [
    { field: "purpose", op: "eq", value: "session-end" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  return rows.some((row) => row.data?.targets === undefined);
}

/** The pending-end rows of one sweep, oldest first. */
export const PENDING_END_PAGE = 5;

/**
 * The least calls of the page of one pending-end row: the session read,
 * the lock, a link read, a delete, and the row delete. The sweep keeps
 * them from the outbox while a row waits (ruling 50 of plan 12f).
 */
export const PENDING_PAGE_RESERVE = 5;

/**
 * The read of the sweep step of the pending-end rows (ruling 44 of plan
 * 12f): the oldest rows, in 1 call of `meter`. It reads nothing when the
 * read and one page do not fit `limit`.
 */
export async function readPendingEnds(
  storage: StorageAdapter,
  meter: Meter,
  limit: number,
): Promise<VerificationRow[]> {
  if (meter.used + 1 + PENDING_PAGE_RESERVE > limit) return [];
  const pending = await storage.findMany(
    "verification",
    [{ field: "purpose", op: "eq", value: "session-end" }],
    { sort: { field: "id", dir: "asc" }, limit: PENDING_END_PAGE },
  );
  meter.step(1);
  return pending;
}

/**
 * The work of the sweep step of the pending-end rows, inside `limit` calls
 * of `meter`. For each row, one transaction ends a page of the user's
 * sessions from before `data.before` (`endSessionPage`, with the locks by
 * id). It deletes the row when no such session stays. `session.afterEnd`
 * fires after the commit, with the reason of the row. A row that does not
 * fit waits for the next sweep. The answer is the count of ended sessions.
 */
export async function endPendingRows(
  config: ResolvedConfig,
  pending: readonly VerificationRow[],
  meter: Meter,
  limit: number,
): Promise<number> {
  const { storage } = config;
  let n = 0;
  for (const row of pending) {
    if (meter.used + PENDING_PAGE_RESERVE > limit) break;
    const before = new Date(String(row.data?.before));
    const reason = pendingReason(row.data?.reason);
    const targets = row.data?.targets;
    const where: Where<"session">[] = [
      ...(Array.isArray(targets)
        ? impersonationWhere(row.identifier, targets.map(String))
        : [{ field: "userId" as const, op: "eq" as const, value: row.identifier }]),
      { field: "createdAt", op: "lte", value: before },
    ];
    const ended = endedList(config);
    // The impersonation sessions of the row end with their stop rows (ruling 43 of plan 12f).
    const stops = impersonationStops(config, PENDING_STOP_CAUSE[reason]);
    const now = config.clock.now();
    // The delete of the row stays out of the page.
    const pageBudget = limit - meter.used - 1;
    const done = await storage.transaction(async (tx) => {
      const read = await tx.findMany("session", where, {
        sort: { field: "id", dir: "asc" },
        limit: END_ALL_LIMIT.default + 1,
      });
      const rows = read.slice(0, END_ALL_LIMIT.default);
      const page =
        rows.length > 0
          ? await endSessionPage(tx, config, rows, ended ?? null, now, pageBudget, where, stops)
          : { deleted: 0, stopped: false, used: 1 };
      const finished = !page.stopped && read.length <= rows.length;
      if (finished) await tx.delete("verification", [{ field: "id", op: "eq", value: row.id }]);
      return { page, finished };
    });
    meter.step(done.page.used + (done.finished ? 1 : 0));
    n += done.page.deleted;
    await sessionsEnded(config, ended, reason, stops);
    if (!done.finished) break;
  }
  return n;
}
