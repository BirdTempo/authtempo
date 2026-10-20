import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow } from "../../schema.js";
import { sendNotice } from "../notices.js";
import { endSessionById } from "../oauth-outbox.js";
import { openSession, type ResolvedSession, sessionOpened, sessionsEnded } from "../sessions.js";
import { auditDraft, operatorAct, operatorReason } from "./audit.js";
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
 * Starts an impersonation (spec 26 item 9). The checks, in order: the tool
 * is on (`not_found`); the operator's session is not an impersonation
 * session; `requireOperatorUser`; the count on
 * `operator-impersonate:user:<operatorId>`; the reason; the user id. A
 * target that is the operator, a platform operator, a user with an active
 * ban, or absent answers `impersonation_refused`: one code, so the route
 * does not tell a missing user from a protected one.
 *
 * Through `operatorAct` with the action `impersonation_start`, one
 * transaction opens the session through `openSession` with `via:
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
  // A ban or an account delete that commits after the read: the session
  // write stops (`writeSession`), and the answer is the one code of a target.
  if (!done.ok)
    return done.code === "account_banned" || done.code === "conflict"
      ? fail("impersonation_refused")
      : done;
  return ok({ token: done.value.token, session: done.value.session, auditId: done.value.auditId });
}

/**
 * Stops an impersonation (spec 26 item 9). A session with no `actorId`
 * answers `not_found`. Through `operatorAct` with the action
 * `impersonation_stop`, it ends the row by id (`endSessionById`, with the
 * outbox rows of its client links), and the audit row names the operator
 * of the row. A row that another call ended answers `not_found`. After the
 * commit, `session.afterEnd` fires with `impersonation_end`. No logout goes
 * inline (ruling 37): an impersonation session cannot reach the authorize
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
      data: { sessionId: session.id },
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
      if ((await endSessionById(tx, session, now)) !== 1) return fail("not_found");
      ends.ended?.push(session);
      return ok({});
    },
    { committed: (_value, ends) => sessionsEnded(config, ends.ended, "impersonation_end") },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}
