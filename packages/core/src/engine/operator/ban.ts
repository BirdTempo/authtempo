import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { UserRow } from "../../schema.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import { runAfter, runBefore, type UserPatch, type UserUpdateVia } from "../hooks.js";
import { deliverLogouts } from "../oauth-logout.js";
import { ROUNDS } from "../rounds.js";
import { later } from "../second-factor.js";
import { endAllAccess } from "../session-list.js";
import { deleteEndedSessions, sessionsEnded } from "../sessions.js";
import { auditDraft, type OperatorActEnds, operatorAct, operatorReason } from "./audit.js";
import { isPlatformOperator, type OperatorActor, requireScope } from "./guards.js";

const MINUTE_MS = 60_000;

/** The nearest end of a timed ban: 1 minute after now. A shorter ban ends before a person reads it. */
const UNTIL_MIN_MS = MINUTE_MS;

/** The latest end of a timed ban: 3650 days after now. A longer ban is a ban with no end. */
const UNTIL_MAX_MS = 3650 * 86_400_000;

/** An ISO 8601 date and time with a zone, as `Date.prototype.toISOString` writes it or with an offset. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The input of a ban (spec 26 items 5 and 6). `until` absent: the ban has no end. */
export interface BanInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  /** An ISO date and time from 1 minute to 3650 days after now. */
  until?: string;
  ip: string | null;
  userAgent: string | null;
}

/** The input of an unban. */
export interface UnbanInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/** The end of a timed ban, or null for no end. `invalid_body` outside 1 minute to 3650 days after now. */
function banEnd(until: unknown, now: Date): Result<Date | null> {
  if (until === undefined) return ok(null);
  if (typeof until !== "string" || !ISO_DATE_TIME.test(until)) return fail("invalid_body");
  const end = new Date(until);
  const ms = end.getTime() - now.getTime();
  if (Number.isNaN(ms) || ms < UNTIL_MIN_MS || ms > UNTIL_MAX_MS) return fail("invalid_body");
  return ok(end);
}

/** The first checks, in order: the tool is on, the actor holds the scope `users`, and the reason is valid. */
function reasonOf(config: ResolvedConfig, input: { actor: OperatorActor; reason: unknown }) {
  if (!config.operator?.users) return fail("not_found");
  const scoped = requireScope(input.actor, "users");
  if (!scoped.ok) return scoped;
  return operatorReason(input.reason);
}

/**
 * The target checks: the user exists, a user actor does not act on their
 * own user (`operator_self`), and a user actor does not act on a platform
 * operator (`operator_required`, spec 26 item 1). A secret and the app can
 * act on a platform operator.
 */
async function targetOf(
  config: ResolvedConfig,
  input: { actor: OperatorActor; userId: unknown },
): Promise<Result<true>> {
  if (typeof input.userId !== "string") return fail("invalid_body");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!user) return fail("not_found");
  if (input.actor.kind === "user") {
    if (input.actor.user.id === user.id) return fail("operator_self");
    if (await isPlatformOperator(config, user.id)) return fail("operator_required");
  }
  return ok(true);
}

/**
 * The write of the ban fields in the act's transaction: `user.beforeUpdate`,
 * then a compare-and-set on `updatedAt` (spec 8.15 item 10: the user row
 * first, the lock order of every account write). A lost round reads the
 * row again and runs the hook again with it. After `ROUNDS` lost rounds the
 * answer is `conflict`.
 */
async function writeBanFields(
  config: ResolvedConfig,
  tx: StorageAdapter,
  userId: string,
  patch: Required<Pick<UserPatch, "bannedAt" | "banReason" | "banUntil">>,
  via: UserUpdateVia,
  now: Date,
): Promise<Result<{ previous: UserRow; user: UserRow }>> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let previous = await tx.findOne("user", byId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!previous) return fail("not_found");
    await runBefore("user.beforeUpdate", config.hooks.user.beforeUpdate, {
      user: previous,
      patch,
      via,
    });
    const updatedAt = later(now, previous.updatedAt);
    const n = await tx.update(
      "user",
      [...byId, { field: "updatedAt", op: "eq", value: previous.updatedAt }],
      { ...patch, updatedAt },
    );
    if (n === 1) return ok({ previous, user: { ...previous, ...patch, updatedAt } });
    previous = await tx.findOne("user", byId);
  }
  console.error("authtempo: operator ban write gave up", userId);
  return fail("conflict");
}

/** `user.afterUpdate` after the commit, with the row before and after the act. */
async function userUpdated(
  config: ResolvedConfig,
  value: { previous: UserRow; user: UserRow },
  via: UserUpdateVia,
): Promise<void> {
  await runAfter(
    "user.afterUpdate",
    config.hooks.user.afterUpdate,
    { user: value.user, previous: value.previous, via },
    value.user.id,
  );
}

/**
 * Bans a user (spec 26 items 5 and 6). ASVS 5.0.0 7.4.2: "Verify that the
 * application terminates all active sessions when a user account is
 * disabled or deleted (such as an employee leaving the company)." One
 * transaction writes the ban fields, ends every session, challenge,
 * handoff code, and OAuth refresh token and code (`endAllAccess`), and
 * writes the audit row. The API tokens stay, and work again after an
 * unban. A ban of a banned user replaces the time, the reason, and the end.
 *
 * After the commit, in the order of ruling 2: `session.afterEnd` with
 * `banned` per session, the back-channel logouts, `user.afterUpdate`, then
 * `afterAction` and `endFamilies` in `operatorAct`.
 */
export async function banUser(
  config: ResolvedConfig,
  input: BanInput,
): Promise<Result<{ auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const now = config.clock.now();
  const until = banEnd(input.until, now);
  if (!until.ok) return until;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const drafted = auditDraft(input.actor, {
    action: "ban",
    targetUserId: input.userId,
    reason: reason.value,
    data: { until: until.value?.toISOString() ?? null },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, _draft, ends: OperatorActEnds) => {
      const written = await writeBanFields(
        config,
        tx,
        input.userId,
        { bannedAt: now, banReason: reason.value, banUntil: until.value },
        "ban",
        now,
      );
      if (!written.ok) return written;
      // An ended row goes with no hook, as in the revoke of the other
      // sessions: it gets no `banned` event (plan 12a review L3).
      await deleteEndedSessions(tx, config, input.userId, now);
      await endAllAccess(tx, input.userId, ends.ended ?? null, ends.families, now);
      return written;
    },
    {
      async committed(value, ends) {
        await sessionsEnded(config, ends.ended, "banned");
        await deliverLogouts(config, input.userId);
        await userUpdated(config, value, "ban");
      },
    },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}

/**
 * Lifts a ban (spec 26 item 5): the three ban fields go to null, with the
 * audit row in the same transaction. It restores no session: each one the
 * ban ended stays ended. An unban of a user with no ban answers ok and
 * writes its row, because the operator's intent is a record.
 */
export async function unbanUser(
  config: ResolvedConfig,
  input: UnbanInput,
): Promise<Result<{ auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const now = config.clock.now();
  const drafted = auditDraft(input.actor, {
    action: "unban",
    targetUserId: input.userId,
    reason: reason.value,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const done = await operatorAct(
    config,
    drafted.value,
    (tx) =>
      writeBanFields(
        config,
        tx,
        input.userId,
        { bannedAt: null, banReason: null, banUntil: null },
        "unban",
        now,
      ),
    { committed: (value) => userUpdated(config, value, "unban") },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}
