import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow } from "../schema.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { requireFresh } from "./fresh.js";
import { deleteOAuthTokens } from "./oauth-grants.js";
import { deleteTwoFactorChallenges } from "./second-factor.js";
import {
  endedList,
  endSessions,
  type ResolvedSession,
  sessionCapMs,
  sessionsEnded,
} from "./sessions.js";

/**
 * The sessions of a settings page (plan 12a, spec 8.15; ASVS 5.0.0 7.5.2):
 * the list with no new proof, and the revoke of one or of the others with a
 * fresh session.
 */

const DAY_MS = 86_400_000;

/** The rows of one list answer. A person with more ends the old ones first. */
export const SESSION_LIST_MAX = 100;
// Per 15 minutes, per user, for the revoke of one and of the others together
// (plan 12a). A list holds at most 100 rows, so 30 revokes cover a cleanup,
// and the key bounds a script that loops on a stolen fresh session.
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
}

/**
 * The conditions of a live session of `userId` at `now`: not expired, and
 * not past the absolute cap. A row written before `absoluteDays` was set can
 * hold an expiresAt past the cap (plan 12b), and `resolveSession` ends it on
 * its next read, so the list must not show it and a revoke must not count it.
 */
function liveOf(config: ResolvedConfig, userId: string, now: Date): Where<"session">[] {
  const where: Where<"session">[] = [
    { field: "userId", op: "eq", value: userId },
    { field: "expiresAt", op: "gt", value: now },
  ];
  const days = config.session.absoluteDays;
  if (days !== null)
    where.push({ field: "createdAt", op: "gt", value: new Date(now.getTime() - days * DAY_MS) });
  return where;
}

/** The user's live sessions, newest first, at most `SESSION_LIST_MAX`. No limit: a read of the caller's own rows. */
export async function listSessions(
  config: ResolvedConfig,
  input: { session: ResolvedSession },
): Promise<Result<SessionSummary[]>> {
  const rows = await config.storage.findMany(
    "session",
    liveOf(config, input.session.user.id, config.clock.now()),
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
    })),
  );
}

/**
 * Ends one live session of the user (plan 12a). Another user's id, an
 * unknown id, and an ended id answer `not_found`. The delete is by id and
 * user, and only a delete count of 1 fires `session.afterEnd`, as in
 * `destroySession`: of two parallel ends of one row, one wins and one event fires.
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
    ...liveOf(config, user.id, config.clock.now()),
  ]);
  if (!row) return fail("not_found");
  const n = await config.storage.delete("session", [
    { field: "id", op: "eq", value: row.id },
    { field: "userId", op: "eq", value: user.id },
  ]);
  // Zero rows: a sign-out, a revoke, or the expiry read ended the row first, and fired its event.
  if (n !== 1) return fail("not_found");
  await sessionsEnded(config, [row], "revoked");
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
 * Ends every session of the user but one, and the sessions in waiting, inside
 * the caller's transaction (plan 12a): the second-factor challenges first (a
 * verify spends its challenge as its last statement, plan 9f), the sessions,
 * then the handoff codes. A code of the caller's own browser goes too; it
 * costs one more handoff. The trusted devices, the API tokens, and the OAuth
 * grants stay: each has its own list and revoke. Answers the sessions it
 * deleted.
 */
export async function endOtherSessions(
  tx: StorageAdapter,
  userId: string,
  keepSessionId: string,
  ended: SessionRow[] | null,
): Promise<number> {
  await deleteTwoFactorChallenges(tx, userId);
  const n = await endSessions(
    tx,
    [
      { field: "userId", op: "eq", value: userId },
      { field: "id", op: "ne", value: keepSessionId },
    ],
    ended,
  );
  await deleteHandoffCodes(tx, userId);
  return n;
}

/**
 * `endOtherSessions`, then the OAuth refresh tokens and codes (plan 12a): the
 * other access that a change of a credential ends. The password change and
 * the change of address call it, so the two lists cannot drift. The OAuth
 * delete comes after the session delete, the order of a reset (plan 9g).
 */
export async function endOtherAccess(
  tx: StorageAdapter,
  userId: string,
  keepSessionId: string,
  ended: SessionRow[] | null,
): Promise<number> {
  const n = await endOtherSessions(tx, userId, keepSessionId, ended);
  await deleteOAuthTokens(tx, userId);
  return n;
}

/**
 * Ends every other session of the user in one transaction (plan 12a). A
 * sign-in that commits after the read still loses its row to the last delete
 * by `where`, and that row fires no hook (plan 9d). Answers the count.
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
  const n = await config.storage.transaction((tx) =>
    endOtherSessions(tx, user.id, session.id, ended ?? null),
  );
  await sessionsEnded(config, ended, "revoked");
  return ok({ ended: n });
}
