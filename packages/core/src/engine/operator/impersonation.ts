import { IMPERSONATION_TTL_MAX_MINUTES, type ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { sendNotice } from "../notices.js";
import { endSessionById } from "../oauth-outbox.js";
import {
  endSessions,
  openSession,
  type ResolvedSession,
  sessionOpened,
  sessionsEnded,
} from "../sessions.js";
import { holdUser } from "../user-hold.js";
import {
  auditDraft,
  type ImpersonationStops,
  impersonationTargets,
  operatorAct,
  operatorReason,
} from "./audit.js";
import { activeBan } from "./ban-rule.js";
import { IMPERSONATE_PER_USER, isPlatformOperator, requireOperatorUser } from "./guards.js";

const MINUTE_MS = 60_000;

/**
 * The reason of a stop that names none. The start row holds the operator's
 * reason; a stop is the end of that act, so a fixed text says what happened.
 */
export const STOP_REASON = "The operator stopped the impersonation.";

/** The input of `startImpersonation` (spec 26 item 9). */
export interface ImpersonationStart {
  /** The platform operator's own session: it must pass `requireOperatorUser`. */
  operator: ResolvedSession;
  userId: string;
  reason: string;
  /** The operator's IP and user agent, for the audit row only. */
  ip: string | null;
  userAgent: string | null;
}

/** The input of `stopImpersonation`. `reason` is optional: the default is `STOP_REASON`. */
export interface ImpersonationStop {
  /** The impersonation session to end. */
  session: ResolvedSession;
  reason?: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * `impersonation_session` for an impersonation session, else ok (spec 26
 * item 9). Each in-process call of an act that the router refuses to such
 * a session runs it first, so the two doors answer one code.
 */
export function refuseImpersonation(resolved: Pick<ResolvedSession, "session">): Result<true> {
  return resolved.session.actorId === null ? ok(true) : fail("impersonation_session");
}

/**
 * Starts an impersonation (spec 26 item 9). The checks run in this order.
 * The tool is on (`not_found`). The operator's session is not an
 * impersonation session. Then `requireOperatorUser`, the count on
 * `operator-impersonate:user:<operatorId>`, the reason, and the user id.
 * A target that is the operator, a platform operator, a user with an active
 * ban, or absent answers `impersonation_refused`. It is one code, so the
 * route does not tell a missing user from a protected one.
 *
 * Through `operatorAct` with the action `impersonation_start`, one
 * transaction first holds the operator's user row and reads the operator
 * again through it. An active ban or a lost platform role answers
 * `operator_required` (ruling 42 of plan 12f). Then it opens the session
 * through `openSession` with `via:
 * "impersonation"`: `actorId` is the operator, `freshAt` is null, and
 * `expiresAt` is now plus `ttlMinutes`. The row holds no IP and no user
 * agent, because the user's session list shows them (plan 12f deviation
 * 13). The audit row's `data` is `{ sessionId, expiresAt }`. After the
 * commit: `session.afterCreate`, then the notice `impersonation_started`
 * when `notice` is on, with no IP.
 */
export async function startImpersonation(
  config: ResolvedConfig,
  input: ImpersonationStart,
  route = "api",
): Promise<Result<{ token: string; session: SessionRow; auditId: string }>> {
  const settings = config.operator?.impersonation;
  if (!settings) return fail("not_found");
  const own = refuseImpersonation(input.operator);
  if (!own.ok) return own;
  const guard = await requireOperatorUser(config, input.operator, route);
  if (!guard.ok) return guard;
  const actor = guard.value;
  if (
    !(await config.limiter.allow(
      `operator-impersonate:user:${actor.user.id}`,
      IMPERSONATE_PER_USER,
    ))
  )
    return fail("rate_limited");
  const reason = operatorReason(input.reason);
  if (!reason.ok) return reason;
  if (typeof input.userId !== "string") return fail("invalid_body");
  const now = config.clock.now();
  const target = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (
    !target ||
    target.id === actor.user.id ||
    activeBan(target, now) ||
    (await isPlatformOperator(config, target.id))
  )
    return fail("impersonation_refused");
  const expiresAt = new Date(now.getTime() + settings.ttlMinutes * MINUTE_MS);
  const drafted = auditDraft(actor, {
    action: "impersonation_start",
    targetUserId: target.id,
    reason: reason.value,
    data: { expiresAt: expiresAt.toISOString() },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, draft) => {
      // The operator's user row first (user-hold.ts), then the operator again
      // through tx. A ban or a revoke that committed after the guard stops
      // the start here. One that starts later waits for this commit. Then
      // its `endImpersonations` reads the start row.
      await holdUser(tx, actor.user.id);
      const self = await tx.findOne("user", [{ field: "id", op: "eq", value: actor.user.id }]);
      if (!self || activeBan(self, now)) return fail("operator_required");
      if (!(await isPlatformOperator(config, self.id, tx))) return fail("operator_required");
      const opened = await openSession(
        config,
        {
          user: target,
          ip: null,
          userAgent: null,
          via: "impersonation",
          impersonation: { actorId: actor.user.id, expiresAt },
        },
        tx,
      );
      draft.data = { sessionId: opened.session.id, expiresAt: expiresAt.toISOString() };
      return ok(opened);
    },
    {
      async committed(value) {
        await sessionOpened(config, value.session, target, "impersonation");
        if (settings.notice)
          await sendNotice(config, {
            event: "impersonation_started",
            email: target.email,
            ip: null,
            userAgent: null,
          });
      },
    },
  );
  // A ban or an account delete of the target can commit after the read.
  // Then the session write stops (`writeSession`), and the answer is the
  // one code of a target.
  if (!done.ok)
    return done.code === "account_banned" || done.code === "conflict"
      ? fail("impersonation_refused")
      : done;
  return ok({ token: done.value.token, session: done.value.session, auditId: done.value.auditId });
}

/**
 * Stops an impersonation (spec 26 item 9). A session with no `actorId`
 * answers `not_found`. It runs through `operatorAct` with the action
 * `impersonation_stop`. It ends the row by id (`endSessionById`, with the
 * outbox rows of its client links). The audit row names the operator of
 * the row. A row that another call ended answers `not_found`. After the
 * commit, `session.afterEnd` fires with `impersonation_end`. No logout goes
 * inline (ruling 37). An impersonation session cannot reach the authorize
 * step, so it has no client link, and the sweep delivers any outbox row.
 */
export async function stopImpersonation(
  config: ResolvedConfig,
  input: ImpersonationStop,
): Promise<Result<{ auditId: string }>> {
  const { session, user } = input.session;
  const operatorId = session.actorId;
  if (operatorId === null) return fail("not_found");
  const drafted = auditDraft(
    { kind: "user", user: { id: operatorId } },
    {
      action: "impersonation_stop",
      targetUserId: user.id,
      reason: input.reason ?? STOP_REASON,
      data: { sessionId: session.id, cause: "stop" },
      ip: input.ip,
      userAgent: input.userAgent,
    },
  );
  if (!drafted.ok) return drafted;
  const now = config.clock.now();
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, _draft, ends) => {
      // The act's own audit row is the stop row, so the delete writes none.
      if ((await endSessionById(tx, session, now, null)) !== 1) return fail("not_found");
      ends.ended?.push(session);
      return ok({});
    },
    { committed: (_value, ends) => sessionsEnded(config, ends.ended, "impersonation_end", null) },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}

/**
 * The targets of the impersonations that `operatorId` may still hold, and
 * the proof that their session rows are locked (ruling 42 L3 of plan 12f).
 * `holdImpersonations` makes it, and `endImpersonations` reads it.
 */
export interface ImpersonationHold {
  readonly operatorId: string;
  readonly targets: readonly string[];
}

/**
 * Reads the targets of `operatorId` and takes the row locks of their
 * sessions in one `lockInOrder` read, in the caller's transaction. The
 * start rows of the last `IMPERSONATION_TTL_MAX_MINUTES` name each target
 * through the audit index on `actorId`. No impersonation session lives
 * longer.
 *
 * With `own`, the same read also locks the operator's own sessions, which
 * the caller deletes next. A page of `endAll` locks by id across users.
 * With two lock reads, it could hold a row of one set and wait on the
 * other (ruling 36). The port has no OR, so the read locks every session
 * of the operator and of each target. Call it before any session delete of
 * the transaction. With no target, it locks nothing, and the deletes of
 * the caller take their own locks.
 */
export async function holdImpersonations(
  tx: StorageAdapter,
  operatorId: string,
  now: Date,
  own: boolean,
): Promise<ImpersonationHold> {
  const since = new Date(now.getTime() - IMPERSONATION_TTL_MAX_MINUTES * MINUTE_MS);
  const targets = await impersonationTargets(tx, operatorId, since);
  if (targets.length > 0)
    await tx.lockInOrder?.(
      "session",
      own
        ? [{ field: "userId", op: "in", value: [operatorId, ...targets] }]
        : [
            { field: "userId", op: "in", value: targets },
            { field: "actorId", op: "eq", value: operatorId },
          ],
    );
  return { operatorId, targets };
}

/**
 * Ends every impersonation session that the platform operator of `hold`
 * opened, in the caller's transaction (ruling 31 of plan 12f). Each loss of
 * the platform role calls it, so nothing of the operator's acts stays (spec
 * 26). The losses are the ban, the revoke, and the account delete. A
 * removal or a leave of the platform organization, and a role change that
 * drops the role, are losses too (ruling 42 I1). One `endSessions` per
 * target deletes the target's sessions whose `actorId` is the operator,
 * with the outbox rows of their links. The answer is the count of sessions.
 */
export async function endImpersonations(
  tx: StorageAdapter,
  hold: ImpersonationHold,
  ended: SessionRow[] | null,
  now: Date,
  stops: ImpersonationStops | null,
): Promise<number> {
  let n = 0;
  for (const userId of hold.targets) {
    n += await endSessions(
      tx,
      [
        { field: "userId", op: "eq", value: userId },
        { field: "actorId", op: "eq", value: hold.operatorId },
      ],
      ended,
      now,
      stops,
    );
  }
  return n;
}
