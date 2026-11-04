import {
  OAUTH_CODE_TTL_MINUTES_MAX,
  OAUTH_DEVICE_CODE_TTL_MINUTES_MAX,
  OAUTH_REFRESH_TTL_DAYS_MAX,
  type ResolvedConfig,
} from "../../config.js";
import { sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import type { SessionRow, VerificationRow } from "../../schema.js";
import { IN_CHUNK } from "../../storage/batch.js";
import type { Meter } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import type { SessionEndReason } from "../hooks.js";
import { familyStart, revokeFamily } from "../oauth-family.js";
import { deleteOAuthCodes } from "../oauth-grants.js";
import { deleteTwoFactorChallenges, later } from "../second-factor.js";
import { deleteHandoffCodes } from "../session-list.js";
import { deleteEndedSessions, endedList, sessionsEnded } from "../sessions.js";
import {
  type ImpersonationStops,
  impersonationStops,
  type OperatorActEnds,
  type StopCause,
  stoppedSessions,
  writeStopRow,
} from "./audit.js";
import { ACCESS_END_RECORD } from "./guards.js";
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
 * name only impersonation sessions. `revoked` comes from a SCIM deactivate
 * (plan 12d Task 10).
 */
export type PendingEndReason = Extract<
  SessionEndReason,
  "banned" | "operator" | "account_deleted" | "impersonation_end" | "revoked"
>;

/** The cause of the stop row of an impersonation session that a pending-end row ends. */
const PENDING_STOP_CAUSE: Readonly<Record<PendingEndReason, Exclude<StopCause, "stop">>> = {
  banned: "ban",
  operator: "revoke",
  account_deleted: "account_delete",
  impersonation_end: "role_loss",
  // A SCIM deactivate of plan 12d Task 10: an end by another party.
  revoked: "deprovision",
};

/** The reason of a pending-end row. A row with no known reason is a ban, as before ruling 63. */
function pendingReason(value: unknown): PendingEndReason {
  return typeof value === "string" && Object.hasOwn(PENDING_STOP_CAUSE, value)
    ? (value as PendingEndReason)
    : "banned";
}

/**
 * The life of a pending-end row: 3650 days, far past the life of any
 * session. The sweep ends its work first, so the row never expires before
 * that. The first sweep step deletes the expired verification rows, so a
 * short life could drop a row with work left.
 */
export const PENDING_END_MS = 3650 * 86_400_000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * The margin of a record past the longest life. It covers the clock of an
 * instance that runs ahead and a write in flight at the act. One day is
 * far past both: a clock that runs a day ahead breaks the expiry of every
 * row.
 */
const RECORD_MARGIN_MS = DAY_MS;

/**
 * The skew bound of `before` (ruling 58 of plan 12d): `before` is at least
 * the clock of the act plus 5 s. Another instance can write a session or a
 * family with a clock that runs ahead, also after the act read its rows.
 * On Workers, `Date.now()` returns the time of the last I/O, and it does
 * not advance while code runs (Cloudflare docs, Workers security model,
 * read 2026-10-24). So the clock of a request can lag, and does not run
 * ahead inside the request. That page says nothing of the skew between
 * hosts: 5 s is a margin that core chooses, not a fact of the page. The
 * cost: a session or a family that
 * starts in the 5 s after the act is refused too, as one from before it.
 * A longer bound refuses more such sign-ins, so the bound stays short.
 */
export const ACCESS_END_SKEW_MS = 5_000;

/**
 * The life of a record after its `before`: the longest life of anything
 * that started at or before it, from the config. A session lives
 * `session.ttlDays` after its last refresh, and the door refuses a refresh
 * after the act. A refresh family that the door refuses at each refresh
 * lives as long as its newest token: `oauth.refreshTtlDays` from its write.
 * A code or a device code from before the act can make that token until it
 * expires, so its life comes on top. Then the margin.
 *
 * Another instance of the app can run a longer `oauth.refreshTtlDays`, and
 * write a family that the act does not read (ruling 74 item 7 of plan 12d).
 * So the family life is the bound of the config check, not the value of
 * this config: 365 days, and the longest code, 30 minutes of a device code.
 */
export function recordLife(config: ResolvedConfig): number {
  const session = config.session.ttlDays * DAY_MS;
  const family = config.oauth
    ? OAUTH_REFRESH_TTL_DAYS_MAX * DAY_MS +
      Math.max(OAUTH_CODE_TTL_MINUTES_MAX, OAUTH_DEVICE_CODE_TTL_MINUTES_MAX) * MINUTE_MS
    : 0;
  return Math.max(session, family) + RECORD_MARGIN_MS;
}

/** True when a pending-end row becomes a record after its work: the own sessions of a SCIM deactivate. */
const recordOf = (reason: unknown, targets: unknown) =>
  reason === "revoked" && targets === undefined;
const keepsRecord = (row: VerificationRow) => recordOf(row.data?.reason, row.data?.targets);

/**
 * The life of the record of a row: the later of the life from the config
 * of the act, which the row stores, and the life from the config of the
 * sweep (ruling 58 of plan 12d). A deploy between the act and the sweep
 * can lower `oauth.refreshTtlDays`. A family of the act still lives the
 * life of the act config, so the record must too.
 */
function recordLifeOf(config: ResolvedConfig, row: VerificationRow): number {
  const stored = Number(row.data?.recordLife);
  return Math.max(Number.isFinite(stored) ? stored : 0, recordLife(config));
}

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
 * One delete takes every refresh token of the user. The families count
 * inside the budget (ruling 55 of plan 12d): `endFamilies` after the commit
 * costs one read and 2 calls per family. The families that fit come first,
 * and a page of the least size stays for the sessions. The page gets the
 * calls that stay. When sessions or families stay, the act writes one
 * pending-end row that names the families, and the sweep ends them. Until
 * then the refresh grant refuses such a family (`revokedFor` of the start
 * of the family). With nothing left, a last delete takes a session that a
 * sign-in wrote after the read, with no hook (plan 9d).
 *
 * The answer is the count of ended sessions, `left` when sessions or
 * families stay, and the `before` of the pending-end row, or null.
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
): Promise<{ ended: number; left: boolean; before: Date | null }> {
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
  const families = [...new Set(tokens.map((t) => t.familyId))];
  // The newest sessions first, so the read holds the newest session of the user
  // for `before`, also past the page (ruling 56 of plan 12d). The page takes them by id.
  const read = await tx.findMany("session", byUser, {
    sort: { field: "createdAt", dir: "desc" },
    limit: END_ALL_LIMIT.default + 1,
  });
  meter.step(1);
  const rows = read.slice(0, END_ALL_LIMIT.default).sort((a, b) => (a.id < b.id ? -1 : 1));
  // The calls of the page and of the families: the last steps stay out.
  const room = budget - meter.used - TAIL_CALLS;
  // The families first, after the read of endFamilies; a page of the least size stays for the sessions.
  const fit = Math.floor((room - 1 - (rows.length > 0 ? PAGE_LEAST - 1 : 0)) / FAMILY_CALLS);
  const take = families.slice(0, Math.max(0, Math.min(fit, IN_CHUNK)));
  const rest = families.slice(take.length);
  // With every family taken, the read after the commit takes the whole user, so it also
  // finds a family that a parallel exchange wrote. Else it reads the taken families only.
  const scope: Where<"oauthToken">[] | null =
    rest.length === 0
      ? tokenWhere
      : take.length > 0
        ? [...tokenWhere, { field: "familyId", op: "in", value: take }]
        : null;
  const afterCommit = scope === null ? 0 : 1 + FAMILY_CALLS * take.length;
  // The page counts its read again, so it gets 1 more.
  const pageBudget = room + 1 - afterCommit;
  // No lock of its own: deleteEndedSessions took the locks of every session of the user.
  const page =
    rows.length > 0 && pageBudget >= PAGE_LEAST
      ? await endSessionPage(tx, config, rows, ends.ended ?? null, now, pageBudget, null, stops)
      : { deleted: 0, stopped: rows.length > 0, used: 1 };
  meter.step(page.used - 1);
  await deleteHandoffCodes(tx, userId);
  meter.step(1);
  for (const id of take) ends.families.ids.add(id);
  if (scope) ends.families.scopes.push(scope);
  await tx.delete("oauthToken", tokenWhere);
  meter.step(1);
  await deleteOAuthCodes(tx, userId);
  meter.step(2);
  const left = page.stopped || read.length > rows.length || rest.length > 0;
  let before: Date | null = null;
  let late = 0;
  if (left) {
    // The newest session and family of the user: a row of a clock that runs ahead stays covered (ruling 55).
    const newest = Math.max(
      ...read.map((r) => r.createdAt.getTime()),
      ...tokens.map((t) => Math.max(t.createdAt.getTime(), familyStart(t).getTime())),
    );
    before = await writePendingEnd(tx, config, userId, reason, newest, { families: rest });
  }
  // A sign-in that commits after the read loses its row here, with no hook (plan 9d).
  else late = await tx.delete("session", byUser);
  meter.step(1);
  return { ended: page.deleted + late, left, before };
}

/**
 * The calls of `markAllAccessEnd`: the challenges, the read of the refresh
 * tokens, the reads of the newest session, OAuth code, and approved device
 * row, the handoff codes, and the pending-end row.
 */
export const ACCESS_MARK_CALLS = 7;

/**
 * The small form of `endAllAccessPage` (ruling 66 of plan 12d), in the
 * act's transaction, in `ACCESS_MARK_CALLS` calls of `meter`. It ends no
 * session and no family. It writes one pending-end row that covers every
 * session and names every family of the user. So the doors refuse them at
 * once (`revokedFor`, `familyRevoked`), and the sweep ends them. A raced
 * SCIM deprovision uses it when a full round does not fit the budget.
 *
 * The challenges and the handoff codes go, as in the full form: each one
 * can make a session after the act, which the row does not cover. The
 * OAuth codes and the approved device rows stay. The code exchange and the
 * device poll refuse one that started at or before `before` (ruling 69 of
 * plan 12d), and a family of such a code starts at the code
 * (`familyStart`), so the row covers it too. The answer is the `before`
 * of the row.
 */
export async function markAllAccessEnd(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  meter: Meter,
  reason: PendingEndReason,
): Promise<Date> {
  await deleteTwoFactorChallenges(tx, userId);
  const tokens = await tx.findMany("oauthToken", [{ field: "userId", op: "eq", value: userId }]);
  const newestOf = { sort: { field: "createdAt" as const, dir: "desc" as const }, limit: 1 };
  // The newest session only, for `before` (ruling 56 of plan 12d): the row covers the rest.
  const newest = await tx.findMany(
    "session",
    [{ field: "userId", op: "eq", value: userId }],
    newestOf,
  );
  // The newest OAuth code and approved device row too (ruling 74 item 16 of plan 12d). They
  // stay, and the exchange and the poll refuse one that started at or before `before`. So
  // `before` covers one that an instance with a clock ahead wrote.
  const code = await tx.findMany(
    "verification",
    [
      { field: "purpose", op: "eq", value: "oauth-code" },
      { field: "identifier", op: "eq", value: userId },
    ],
    newestOf,
  );
  const device = await tx.findMany(
    "oauthDevice",
    [{ field: "userId", op: "eq", value: userId }],
    newestOf,
  );
  await deleteHandoffCodes(tx, userId);
  const before = await writePendingEnd(
    tx,
    config,
    userId,
    reason,
    Math.max(
      ...[...newest, ...code, ...device].map((r) => r.createdAt.getTime()),
      ...tokens.map((t) => Math.max(t.createdAt.getTime(), familyStart(t).getTime())),
    ),
    { families: [...new Set(tokens.map((t) => t.familyId))] },
  );
  meter.step(ACCESS_MARK_CALLS);
  return before;
}

/**
 * Ends the impersonation sessions that the operator of `hold` opened, inside
 * `budget` calls of `meter` (rulings 31, 44, and 63 of plan 12f). Every loss
 * of the platform role calls it in its transaction. The losses are the ban,
 * the revoke, and the account delete. A removal, a leave, or a role change
 * of the platform member row is a loss too. One read by the `userId` index
 * takes the sessions, and a page ends them with their stop rows
 * (`endSessionPage`). The page keeps `keep` calls for the steps of the
 * caller after it, and one call for the pending-end row. The rows that do
 * not fit stay with a pending-end row that names the operator and the
 * targets, and the sweep ends them. Until then the door of each session
 * read refuses them (`impersonationLoss`). The answer is the count of
 * ended sessions, and `left` when rows stay (plan 12h Task 5).
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
): Promise<{ ended: number; left: boolean }> {
  if (hold.targets.length === 0) return { ended: 0, left: false };
  const where = impersonationWhere(hold.operatorId, hold.targets);
  const read = await tx.findMany("session", where, {
    sort: { field: "id", dir: "asc" },
    limit: END_ALL_LIMIT.default + 1,
  });
  meter.step(1);
  if (read.length === 0) return { ended: 0, left: false };
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
    const newest = Math.max(...read.map((r) => r.createdAt.getTime()));
    await writePendingEnd(tx, config, hold.operatorId, reason, newest, {
      targets: hold.targets,
    });
    meter.step(1);
  }
  return { ended: page.deleted, left };
}

/** The calls that a ban or a revoke keeps after `endImpersonationsPage`: the own sessions of the user. */
export const ACCESS_END_KEEP = ACCESS_END_LEAST + PAGE_LEAST;

/**
 * The least calls of `endOwnSessionsPage` and of `endImpersonationsPage`,
 * each: the read, and the pending-end row or the last delete.
 */
export const SESSIONS_PAGE_LEAST = 2;

/**
 * The most impersonation sessions of one user that an account delete on a
 * cascading store records for the sweep. Decisions 3 and 4 of plan 12o set
 * it. A delete whose read finds more answers `delete_too_large` before the
 * user delete, so the undo holds on D1. With ids of 26 characters, a list of
 * 100 entries is 8201 bytes of JSON (measured 2026-11-04). Each compat
 * dialect keeps `data` in a text column with no length bound (migration.ts,
 * read 2026-11-04).
 */
export const STOPS_LIMIT = 100;

/**
 * An impersonation session that the cascade of a user delete takes, for its
 * stop row at the sweep (decision 3 of plan 12o). The session row is gone
 * then, and the sweep reads no start row. So the row holds both ids.
 */
export interface PendingStop {
  sessionId: string;
  actorId: string;
}

/**
 * Ends a page of the own sessions of a user whose row the caller deletes,
 * inside `budget` calls of `meter` (ruling 1 of plan 12f2, item B1). The
 * account delete calls it in its transaction. One read by the `userId`
 * index takes the sessions, and a page ends them (`endSessionPage`). The
 * page keeps `keep` calls for the steps of the caller after it. The rows
 * that do not fit stay with one pending-end row, and the sweep ends them.
 * Until then each door refuses them, because the user row is gone. With no
 * row left, a last delete takes a session that a sign-in wrote after the
 * read, with no hook (plan 9d). The answer is the count of ended sessions,
 * and `left` when rows stay.
 *
 * `impersonated` holds the user's live impersonation sessions that the
 * caller read before the page (decision 3 of plan 12o). The caller reads
 * them only on a store whose user delete cascades. Elsewhere it is empty.
 * There the cascade takes each row that the page does not end, and the
 * sweep cannot see it. A session of the list that the page ends gets its
 * stop row in the page. The other sessions of the list go into the
 * pending-end row as `data.stops`, with `data.endedAt` from `now`. The sweep
 * writes their stop rows. The row is written also when no own row stays.
 * Then no last delete runs, because the cascade takes a late session.
 */
export async function endOwnSessionsPage(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  ended: SessionRow[] | null,
  now: Date,
  meter: Meter,
  budget: number,
  keep: number,
  reason: PendingEndReason,
  stops: ImpersonationStops | null,
  impersonated: readonly SessionRow[],
): Promise<{ ended: number; left: boolean }> {
  const byUser: Where<"session">[] = [{ field: "userId", op: "eq", value: userId }];
  const read = await tx.findMany("session", byUser, {
    sort: { field: "id", dir: "asc" },
    limit: END_ALL_LIMIT.default + 1,
  });
  meter.step(1);
  const rows = read.slice(0, END_ALL_LIMIT.default);
  // The page counts its read again, so it gets 1 more. The calls of the caller and the last step stay out.
  const pageBudget = budget - meter.used + 1 - keep - 1;
  // The stop rows that the page writes come after this mark.
  const mark = stops?.rows.length ?? 0;
  // No lock of its own: the caller took the locks of these rows (holdImpersonations).
  const page =
    rows.length > 0 && pageBudget >= PAGE_LEAST
      ? await endSessionPage(tx, config, rows, ended, now, pageBudget, null, stops)
      : { deleted: 0, stopped: rows.length > 0, used: 1 };
  meter.step(page.used - 1);
  const left = page.stopped || read.length > rows.length;
  // The sessions of the list that got no stop row in the page.
  const paid = new Set(stops?.rows.slice(mark).map((r) => r.data?.sessionId));
  const owed: PendingStop[] =
    stops === null
      ? []
      : impersonated.flatMap((r) =>
          r.actorId !== null && !paid.has(r.id) ? [{ sessionId: r.id, actorId: r.actorId }] : [],
        );
  let late = 0;
  // The newest session that the read holds: a row of a clock that runs ahead stays covered
  // (rulings 55 and 58 of plan 12d), as in `endImpersonationsPage`.
  if (left || owed.length > 0)
    await writePendingEnd(
      tx,
      config,
      userId,
      reason,
      Math.max(...read.map((r) => r.createdAt.getTime())),
      owed.length > 0 ? { stops: { owed, endedAt: now } } : {},
    );
  // A sign-in that commits after the read loses its row here, with no hook (plan 9d).
  else late = await tx.delete("session", byUser);
  meter.step(1);
  return { ended: page.deleted + late, left };
}

/** The impersonation sessions of `operatorId` on `targets`: by the `userId` index. */
function impersonationWhere(operatorId: string, targets: readonly string[]): Where<"session">[] {
  return [
    { field: "userId", op: "in", value: [...targets] },
    { field: "actorId", op: "eq", value: operatorId },
  ];
}

/**
 * The pending-end row of a user, in the act's transaction: a verification
 * row with the purpose `session-end`. `data.before` is the later of the
 * clock plus `ACCESS_END_SKEW_MS` and `newest`, the newest `createdAt` that
 * the act read (rulings 55 and 58 of plan 12d). So the sweep and each door
 * cover a row of an instance whose clock runs ahead. A sign-in in the skew
 * bound after the act is covered too. A row that becomes a record holds
 * `data.recordLife`, the record life from the config of the act. With `targets`, the
 * row names the impersonation sessions that the user opened as an
 * operator. These are the sessions of those users whose `actorId` is the
 * user. With
 * `families`, it names the OAuth families that the act did not end. With
 * `stops`, it names the impersonation sessions that a cascade takes, and
 * the time of their end (decision 3 of plan 12o). The
 * sweep reads no start row of the audit table, so the row holds the ids. The
 * answer is `data.before`.
 */
async function writePendingEnd(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  reason: PendingEndReason,
  newest: number,
  names: {
    targets?: readonly string[];
    families?: readonly string[];
    stops?: { owed: readonly PendingStop[]; endedAt: Date };
  },
): Promise<Date> {
  const now = config.clock.now();
  // The clock plus the skew bound covers a row of an instance whose clock runs ahead,
  // also one that it writes after the read (ruling 58). An act that read no row has no newest time.
  const bound = new Date(now.getTime() + ACCESS_END_SKEW_MS);
  const before = Number.isFinite(newest) ? later(bound, new Date(newest)) : bound;
  const id = newId(now);
  await tx.create("verification", {
    id,
    purpose: "session-end",
    identifier: userId,
    // No code: the hash of the id fills the unique key.
    valueHash: await sha256Hex(`session-end:${id}`),
    expiresAt: new Date(now.getTime() + PENDING_END_MS),
    consumedAt: null,
    data: {
      reason,
      before: before.toISOString(),
      ...(names.targets === undefined ? {} : { targets: [...names.targets] }),
      ...(names.families === undefined || names.families.length === 0
        ? {}
        : { families: [...names.families] }),
      ...(names.stops === undefined || names.stops.owed.length === 0
        ? {}
        : {
            stops: names.stops.owed.map((x) => ({ sessionId: x.sessionId, actorId: x.actorId })),
            endedAt: names.stops.endedAt.toISOString(),
          }),
      // The record life from the config of the act (ruling 58).
      ...(recordOf(reason, names.targets) ? { recordLife: recordLife(config) } : {}),
    },
    secretVersion: config.keyring.current,
    createdAt: now,
    updatedAt: now,
  });
  return before;
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
 * them from the outbox while a row waits (ruling 50 of plan 12f). A row
 * that owes stop rows gets the session read, the stop row read, 1 stop row,
 * and the update of the row. Decision 5 and ruling 19 of plan 12o set these
 * calls.
 */
export const PENDING_PAGE_RESERVE = 5;

/**
 * The calls of an update of a pending-end row in the sweep's transaction.
 * On D1 an update there is 2 statements, the undo read and the update.
 */
const ROW_UPDATE_CALLS = 2;

/**
 * The stop rows that the sweep reads for one pending-end row that owes stop
 * rows (ruling 19 of plan 12o). Each session of the delete's read has one
 * stop row at most: of the page, of another flow, or of an earlier sweep.
 * So at most `STOPS_LIMIT` rows name a session of the list. The bound leaves
 * room for as many rows of other sessions of the user.
 */
const STOPPED_READ_LIMIT = 2 * STOPS_LIMIT;

/** The calls that the read of the stop rows needs after it: 1 stop row and the update of the row. */
const STOPPED_READ_ROOM = 1 + ROW_UPDATE_CALLS;

/** True for one entry of `data.stops` of a pending-end row. */
function isPendingStop(entry: unknown): entry is PendingStop {
  if (typeof entry !== "object" || entry === null) return false;
  const { sessionId, actorId } = entry as Record<string, unknown>;
  return typeof sessionId === "string" && typeof actorId === "string";
}

/**
 * The stop rows that a pending-end row still owes, and `endedAt`, the time
 * of the delete (decision 5 of plan 12o). A row with no such list owes none.
 */
function owedStops(row: VerificationRow): { owed: PendingStop[]; endedAt: string | undefined } {
  const list: unknown = row.data?.stops;
  const owed = Array.isArray(list)
    ? list.filter(isPendingStop).map((x) => ({ sessionId: x.sessionId, actorId: x.actorId }))
    : [];
  const at = row.data?.endedAt;
  return {
    owed,
    endedAt: typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : undefined,
  };
}

/**
 * The read of the sweep step of the pending-end rows (ruling 44 of plan
 * 12f): the oldest rows, in 1 call of `meter`. It reads nothing when the
 * read and one page do not fit `limit`. `also` names more purposes of
 * pending rows that the same read takes (ruling 78 of plan 12d), so the
 * sweep spends no call more for them.
 */
export async function readPendingEnds(
  storage: StorageAdapter,
  meter: Meter,
  limit: number,
  also: readonly string[] = [],
): Promise<VerificationRow[]> {
  if (meter.used + 1 + PENDING_PAGE_RESERVE > limit) return [];
  const pending = await storage.findMany(
    "verification",
    [
      also.length === 0
        ? { field: "purpose", op: "eq", value: "session-end" }
        : { field: "purpose", op: "in", value: ["session-end", ...also] },
    ],
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
 * fires after the commit, with the reason of the row. Then the families
 * that the row names end (`endPendingFamilies`). A row of a SCIM
 * deactivate is not deleted: it becomes the record of the act
 * (`ACCESS_END_RECORD`). A row that does not fit waits for the next sweep.
 * The answer is the count of ended sessions.
 *
 * A row with `data.stops` owes the stop rows of the impersonation sessions
 * that a cascade took (decision 5 of plan 12o). After the page, one read
 * takes the user's stop rows from `ACCESS_END_SKEW_MS` before
 * `data.endedAt` (`stoppedSessions`, ruling 19). Another flow can end a
 * session of the list after the delete's read, because D1 and SQLite have
 * no row lock. That flow wrote the stop row, so the step skips the entry.
 * The same transaction then writes one `impersonation_stop` row per other
 * entry, one call each, in the calls that stay. Each row holds
 * `data.endedAt`, the time of the delete. Then one update leaves the rest of
 * the list on the row, or the row goes when no entry and no session stays.
 * A row with entries left waits for the next sweep. `operator.afterAction`
 * runs once per stop row after the commit, through `sessionsEnded`.
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
    const families = Array.isArray(row.data?.families) ? row.data.families.map(String) : [];
    const where: Where<"session">[] = [
      ...(Array.isArray(targets)
        ? impersonationWhere(row.identifier, targets.map(String))
        : [{ field: "userId" as const, op: "eq" as const, value: row.identifier }]),
      { field: "createdAt", op: "lte", value: before },
    ];
    const byId: Where<"verification">[] = [{ field: "id", op: "eq", value: row.id }];
    const ended = endedList(config);
    // The impersonation sessions of the row end with their stop rows (ruling 43 of plan 12f).
    const cause = PENDING_STOP_CAUSE[reason];
    const stops = impersonationStops(config, cause);
    const { owed, endedAt } = owedStops(row);
    // The delete ran while the tool was on. So the owed rows are written also while it is off now.
    const written = stops ?? (owed.length > 0 ? { cause, rows: [] } : null);
    const now = config.clock.now();
    const calls = limit - meter.used;
    // The delete of the row stays out of the page.
    const pageBudget = calls - 1;
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
      // The owed stop rows: all of them and the row delete, or some of them and the update.
      let paid = 0;
      let due = owed;
      let looked = false;
      if (
        finished &&
        written !== null &&
        owed.length > 0 &&
        calls - page.used >= 1 + STOPPED_READ_ROOM
      ) {
        // A writer whose clock runs behind, or a flow that took its time before the
        // delete's read, wrote an earlier time. The skew bound of `data.before` covers it.
        const at = endedAt === undefined ? row.createdAt.getTime() : Date.parse(endedAt);
        const since = new Date(at - ACCESS_END_SKEW_MS);
        const stopped = await stoppedSessions(tx, row.identifier, since, STOPPED_READ_LIMIT);
        looked = true;
        due = owed.filter((x) => !stopped.has(x.sessionId));
        const room = calls - page.used - 1;
        paid = room - 1 >= due.length ? due.length : Math.max(0, room - ROW_UPDATE_CALLS);
        for (const stop of due.slice(0, paid))
          await writeStopRow(
            tx,
            written,
            { id: stop.sessionId, userId: row.identifier, actorId: stop.actorId },
            now,
            endedAt,
          );
      }
      const rest = due.slice(paid);
      const data =
        rest.length > 0
          ? { ...row.data, stops: rest }
          : Object.fromEntries(
              Object.entries(row.data ?? {}).filter(([k]) => k !== "stops" && k !== "endedAt"),
            );
      // A row that names families stays until they end, after this commit. A
      // record row stays too: endPendingFamilies writes the record.
      const drop = finished && rest.length === 0 && families.length === 0 && !keepsRecord(row);
      if (drop) await tx.delete("verification", byId);
      else if (paid > 0) await tx.update("verification", byId, { data });
      return { page, finished: finished && rest.length === 0, drop, paid, looked, data };
    });
    const rowCalls = done.drop ? 1 : done.paid > 0 ? ROW_UPDATE_CALLS : 0;
    meter.step(done.page.used + (done.looked ? 1 : 0) + done.paid + rowCalls);
    n += done.page.deleted;
    await sessionsEnded(config, ended, reason, written, done.page.deleted);
    if (!done.finished) break;
    if (
      !done.drop &&
      !(await endPendingFamilies(config, { ...row, data: done.data }, families, meter, limit))
    )
      break;
  }
  return n;
}

/**
 * Ends the OAuth families that a pending-end row names, inside `limit`
 * calls of `meter` (ruling 55 of plan 12d). Each family ends with its mark
 * (`revokeFamily`, 2 calls), outside a transaction, so the mark commits
 * before the delete. One call stays for the row: its delete when no family
 * stays, else an update to the families that stay. A row of a SCIM
 * deactivate with no family left becomes its record (ruling 56): one
 * update, as the delete is one call. The answer is true when the work of
 * the row is done.
 */
async function endPendingFamilies(
  config: ResolvedConfig,
  row: VerificationRow,
  families: readonly string[],
  meter: Meter,
  limit: number,
): Promise<boolean> {
  const byId: Where<"verification">[] = [{ field: "id", op: "eq", value: row.id }];
  const fit = Math.max(0, Math.floor((limit - meter.used - 1) / FAMILY_CALLS));
  const end = families.slice(0, fit);
  for (const id of end) {
    await revokeFamily(config, id);
    meter.step(FAMILY_CALLS);
  }
  const rest = families.slice(end.length);
  if (rest.length === 0 && keepsRecord(row)) {
    const before = new Date(String(row.data?.before));
    await config.storage.update("verification", byId, {
      purpose: ACCESS_END_RECORD,
      expiresAt: new Date(before.getTime() + recordLifeOf(config, row)),
      data: { reason: "revoked", before: before.toISOString() },
    });
  } else if (rest.length === 0) await config.storage.delete("verification", byId);
  else if (end.length > 0)
    await config.storage.update("verification", byId, { data: { ...row.data, families: rest } });
  if (rest.length === 0 || end.length > 0) meter.step(1);
  return rest.length === 0;
}
