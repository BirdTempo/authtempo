import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow } from "../schema.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { requireFresh } from "./fresh.js";
import type { FamilyEnds } from "./oauth-family.js";
import { deleteOAuthTokens } from "./oauth-grants.js";
import { deliverLogouts } from "./oauth-logout.js";
import { endSessionById } from "./oauth-outbox.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { deleteTwoFactorChallenges } from "./second-factor.js";
import {
  deleteEndedSessions,
  endedList,
  endSessions,
  liveSessionWhere,
  type ResolvedSession,
  sessionCapMs,
  sessionsEnded,
} from "./sessions.js";

/**
 * The sessions of a settings page (plan 12a, spec 8.15; ASVS 5.0.0 7.5.2).
 * The list needs no new proof. The revoke of one or of the others needs a
 * fresh session.
 */

/** The rows of one list answer. A person with more ends the old ones first. */
export const SESSION_LIST_MAX = 100;
// Per 15 minutes, per user, for the revoke of one and of the others together
// (plan 12a). A list holds at most 100 rows, so 30 revokes cover a cleanup.
// The key also bounds a script that loops on a stolen fresh session.
export const REVOKE_PER_USER = { seconds: 900, max: 30 };

/** The one key of both revoke flows, so the two cannot count apart. */
function revokeAllowed(config: ResolvedConfig, userId: string): Promise<boolean> {
  return config.limiter.allow(`session-revoke:user:${userId}`, REVOKE_PER_USER);
}

/** One row of the list. Never the token or its hash. */
export interface SessionSummary {
  id: string;
  createdAt: Date;
  /** Moves only at the sliding refresh, at most once per `slidingRefreshDays`: a coarse "last active". */
  lastSeenAt: Date;
  /** The earlier of the row's expiry and the absolute cap of plan 12b. */
  expiresAt: Date;
  freshAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  activeOrganizationId: string | null;
  /** True for the session of the caller. */
  current: boolean;
  /**
   * True for a session that a platform operator opened for support (plan
   * 12f, spec 26 item 9). The list names no operator: the user sees the
   * mark, and the audit row holds the operator.
   */
  impersonation: boolean;
}

/**
 * The user's live sessions, newest first, at most `SESSION_LIST_MAX`. A row
 * past the absolute cap of plan 12b is not live, though its expiresAt can be
 * later. No limit applies: the call reads the caller's own rows.
 */
export async function listSessions(
  config: ResolvedConfig,
  input: { session: ResolvedSession },
): Promise<Result<SessionSummary[]>> {
  const rows = await config.storage.findMany(
    "session",
    liveSessionWhere(config, input.session.user.id, config.clock.now()),
    // The id is time-ordered (newId), and the port asks a read list to end with id.
    { sort: [{ field: "id", dir: "desc" }], limit: SESSION_LIST_MAX },
  );
  return ok(
    rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: new Date(Math.min(s.expiresAt.getTime(), sessionCapMs(config, s.createdAt))),
      freshAt: s.freshAt,
      ip: s.ip,
      userAgent: s.userAgent,
      activeOrganizationId: s.activeOrganizationId,
      current: s.id === input.session.session.id,
      impersonation: s.actorId !== null,
    })),
  );
}

/**
 * Ends one live session of the user (plan 12a). Another user's id, an
 * unknown id, and an ended id answer `not_found`. The delete is by id and
 * user. Only a delete count of 1 fires `session.afterEnd`, as in
 * `destroySession`. So of two parallel ends of one row, one wins, and one
 * event fires. The fresh rule comes before the limit: a stale session must
 * not fill the owner's key (review M3).
 */
export async function revokeSession(
  config: ResolvedConfig,
  input: { session: ResolvedSession; id: string },
): Promise<Result<{ current: boolean }>> {
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  const { user } = input.session;
  if (!(await revokeAllowed(config, user.id))) return fail("rate_limited");
  const row = await config.storage.findOne("session", [
    { field: "id", op: "eq", value: input.id },
    ...liveSessionWhere(config, user.id, config.clock.now()),
  ]);
  if (!row) return fail("not_found");
  const now = config.clock.now();
  // The outbox rows of the session's client links, then the delete by id and user (plan 12e Task 16).
  // An impersonation session ends in a transaction with its stop row (ruling 43 of plan 12f).
  const stops = row.actorId === null ? null : impersonationStops(config, "user_end");
  const n = stops
    ? await config.storage.transaction((tx) => endSessionById(tx, row, now, stops))
    : await endSessionById(config.storage, row, now, null);
  // Zero rows: another call ended the row first and fired its event.
  if (n !== 1) return fail("not_found");
  await sessionsEnded(config, [row], "revoked", stops);
  await deliverLogouts(config, user.id);
  return ok({ current: row.id === input.session.session.id });
}

/**
 * A handoff code is a session in waiting: the redeem does not check the
 * session that minted it. So a flow that ends sessions ends the codes too,
 * as `claimEmail` does for a claimant. Moved from password.ts (plan 12a).
 */
export async function deleteHandoffCodes(tx: StorageAdapter, userId: string): Promise<void> {
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "handoff-code" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/**
 * The one list of deletes of a session end (plan 12f deviation 6): the
 * challenges, the sessions that `sessionWhere` matches, then the handoff
 * codes. The challenges go first because a verify spends its challenge as
 * its last statement (plan 9f). `endOtherSessions` and `endAllAccess` both
 * call it, so the two lists cannot drift. `sessionWhere` holds the
 * `userId` term. The answer is the count of sessions that the call deleted.
 */
async function endAccess(
  tx: StorageAdapter,
  userId: string,
  sessionWhere: Where<"session">[],
  ended: SessionRow[] | null,
  now: Date,
  stops: ImpersonationStops | null,
): Promise<number> {
  await deleteTwoFactorChallenges(tx, userId);
  const n = await endSessions(tx, sessionWhere, ended, now, stops);
  await deleteHandoffCodes(tx, userId);
  return n;
}

/**
 * Ends every session of the user but one, and the sessions in waiting, in the
 * caller's transaction (plan 12a), through `endAccess`. A code of the
 * caller's own browser goes too, and costs one more handoff. The trusted
 * devices, the API tokens, and the OAuth grants stay. Each has its own list
 * and revoke. The answer is the count of sessions that the call deleted.
 */
export async function endOtherSessions(
  tx: StorageAdapter,
  userId: string,
  keepSessionId: string,
  ended: SessionRow[] | null,
  now: Date,
  stops: ImpersonationStops | null,
): Promise<number> {
  return endAccess(
    tx,
    userId,
    [
      { field: "userId", op: "eq", value: userId },
      { field: "id", op: "ne", value: keepSessionId },
    ],
    ended,
    now,
    stops,
  );
}

/**
 * `endOtherSessions`, then the OAuth refresh tokens and codes (plan 12a).
 * This is the other access that a change of a credential ends. The password
 * change and the change of address call it, so the two lists cannot drift.
 * The OAuth delete comes after the session delete, as in a reset (plan 9g).
 * The caller ends `families` after its commit (`endFamilies`).
 */
export async function endOtherAccess(
  tx: StorageAdapter,
  userId: string,
  keepSessionId: string,
  ended: SessionRow[] | null,
  families: FamilyEnds,
  now: Date,
  stops: ImpersonationStops | null,
): Promise<number> {
  const n = await endOtherSessions(tx, userId, keepSessionId, ended, now, stops);
  await deleteOAuthTokens(tx, userId, families);
  return n;
}

/**
 * Ends all access of the user in the caller's transaction (plan 12f, ASVS
 * 5.0.0 7.4.2). It ends every session, challenge, and handoff code through
 * `endAccess`, then the OAuth refresh tokens and codes. The API tokens stay:
 * each has its own revoke, and they work again after an unban (spec 26 item
 * 6). The logouts of the links go to the outbox in the same transaction,
 * and the sweep sends them: the caller posts none (ruling 37). After its
 * commit the caller runs `sessionsEnded`, and `endFamilies` last (ruling
 * 2). The answer is the count of sessions.
 * It has no call budget. The ban and the revoke of the platform role use
 * `endAllAccessPage` of `operator/access-end.ts` (ruling 44 of plan 12f).
 */
export async function endAllAccess(
  tx: StorageAdapter,
  userId: string,
  ended: SessionRow[] | null,
  families: FamilyEnds,
  now: Date,
  stops: ImpersonationStops | null,
): Promise<number> {
  const n = await endAccess(
    tx,
    userId,
    [{ field: "userId", op: "eq", value: userId }],
    ended,
    now,
    stops,
  );
  await deleteOAuthTokens(tx, userId, families);
  return n;
}

/**
 * Ends every other session of the user in one transaction (plan 12a). The
 * ended rows go first, with no hook and no count: an expired row gets no
 * `revoked` event (review L3). A sign-in that commits after the read loses
 * its row to the last delete, with no hook (plan 9d). The answer is the count.
 */
export async function revokeOtherSessions(
  config: ResolvedConfig,
  input: { session: ResolvedSession },
): Promise<Result<{ ended: number }>> {
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  const { user, session } = input.session;
  if (!(await revokeAllowed(config, user.id))) return fail("rate_limited");
  const ended = endedList(config);
  const stops = impersonationStops(config, "user_end");
  const now = config.clock.now();
  const n = await config.storage.transaction(async (tx) => {
    // An ended row goes with no hook. Its client links become logouts in
    // `endSessions` below: an expiry ends a session too (ruling 49).
    await deleteEndedSessions(tx, config, user.id, now);
    return endOtherSessions(tx, user.id, session.id, ended ?? null, now, stops);
  });
  await sessionsEnded(config, ended, "revoked", stops);
  await deliverLogouts(config, user.id);
  return ok({ ended: n });
}
