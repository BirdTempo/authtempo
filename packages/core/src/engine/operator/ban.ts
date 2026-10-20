import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { UserRow } from "../../schema.js";
import { meterOf } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import { runAfter, runBefore, type UserPatch, type UserUpdateVia } from "../hooks.js";
import { ROUNDS } from "../rounds.js";
import { later } from "../second-factor.js";
import { sessionsEnded } from "../sessions.js";
import { ACCESS_END_LEAST, endAllAccessPage, endImpersonationsPage } from "./access-end.js";
import {
  auditDraft,
  impersonationStops,
  type OperatorActEnds,
  operatorAct,
  operatorReason,
} from "./audit.js";
import { activeBan } from "./ban-rule.js";
import { isPlatformOperator, type OperatorActor, requireScope } from "./guards.js";
import { holdImpersonations } from "./impersonation.js";
import { STEP_WORST, TARGET_CALLS, workBudget } from "./sessions.js";

const MINUTE_MS = 60_000;

/** The nearest end of a timed ban: 1 minute after now. A shorter ban ends before a person reads it. */
const UNTIL_MIN_MS = MINUTE_MS;

/** The latest end of a timed ban: 3650 days after now. A longer ban is a ban with no end. */
const UNTIL_MAX_MS = 3650 * 86_400_000;

/**
 * An ISO 8601 date and time with a zone, as `Date.prototype.toISOString`
 * writes it or with an offset. The groups: year, month, day, hour, minute,
 * second, then the offset sign, hours, and minutes.
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * True when the calendar fields of the input name the time that `end`
 * holds. `Date` moves a day that does not exist to a later day: it reads
 * 02-30 as 03-02 (review L2). So a wrong date gives a ban to another day.
 */
function sameFields(fields: RegExpExecArray, end: Date): boolean {
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = fields;
  const offset = sign ? Number(offsetHours) * 60 + Number(offsetMinutes) : 0;
  const local = new Date(end.getTime() + (sign === "-" ? -offset : offset) * MINUTE_MS);
  return (
    local.getUTCFullYear() === Number(year) &&
    local.getUTCMonth() + 1 === Number(month) &&
    local.getUTCDate() === Number(day) &&
    local.getUTCHours() === Number(hour) &&
    local.getUTCMinutes() === Number(minute) &&
    local.getUTCSeconds() === Number(second ?? "0")
  );
}

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

/**
 * The end of a timed ban, or null for no end. `invalid_body` for a date
 * that does not exist, and outside 1 minute to 3650 days after now.
 */
function banEnd(until: unknown, now: Date): Result<Date | null> {
  if (until === undefined) return ok(null);
  const end = isoDateTime(until);
  if (!end) return fail("invalid_body");
  const ms = end.getTime() - now.getTime();
  if (ms < UNTIL_MIN_MS || ms > UNTIL_MAX_MS) return fail("invalid_body");
  return ok(end);
}

/**
 * The time of an ISO 8601 date and time with a zone. Null for another
 * value, and for a date or a time that does not exist. The end of a ban
 * and the time of a factor proof (plan 12f Task 9) share this one rule.
 */
export function isoDateTime(value: unknown): Date | null {
  const fields = typeof value === "string" ? ISO_DATE_TIME.exec(value) : null;
  if (typeof value !== "string" || !fields) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || !sameFields(fields, at)) return null;
  return at;
}

/**
 * The first checks, in order: the tool is on, the actor holds the scope
 * `users`, and the reason is valid. The disable of the second factor (plan
 * 12f Task 9) runs the same checks.
 */
export function reasonOf(
  config: ResolvedConfig,
  input: { actor: OperatorActor; reason: unknown },
): Result<string> {
  if (!config.operator?.users) return fail("not_found");
  const scoped = requireScope(input.actor, "users");
  if (!scoped.ok) return scoped;
  return operatorReason(input.reason);
}

/**
 * The target checks (spec 26 item 1). The user must exist. A user actor
 * does not act on their own user (`operator_self`). A user actor does not
 * act on a platform operator (`operator_required`). A secret and the app
 * can act on a platform operator. The answer is the user row. The grant and
 * the revoke of the platform role (plan 12f Task 8) use the same checks.
 * So does the end of one user's sessions (plan 12f Task 7).
 */
export async function targetOf(
  config: ResolvedConfig,
  input: { actor: OperatorActor; userId: unknown },
): Promise<Result<UserRow>> {
  if (typeof input.userId !== "string") return fail("invalid_body");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!user) return fail("not_found");
  if (input.actor.kind === "user") {
    if (input.actor.user.id === user.id) return fail("operator_self");
    if (await isPlatformOperator(config, user.id)) return fail("operator_required");
  }
  return ok(user);
}

/** The ban fields that an act writes, from the row that it read. */
type BanPatch = Pick<UserPatch, "bannedAt" | "banReason" | "banUntil">;

/**
 * The write of the ban fields in the act's transaction. It runs
 * `user.beforeUpdate`, then a compare-and-set on `updatedAt`. Spec 8.15
 * item 10 puts the user row first, in the lock order of every account
 * write. A lost round reads the row again, and makes the patch and runs
 * the hook again with it. After `ROUNDS` lost rounds the answer is
 * `conflict`.
 */
async function writeBanFields(
  config: ResolvedConfig,
  tx: StorageAdapter,
  userId: string,
  patchOf: (previous: UserRow) => BanPatch,
  via: UserUpdateVia,
  now: Date,
): Promise<Result<{ previous: UserRow; user: UserRow }>> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let previous = await tx.findOne("user", byId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!previous) return fail("not_found");
    const patch = patchOf(previous);
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
 * transaction writes the ban fields, ends every challenge, handoff code,
 * and OAuth refresh token and code, and a page of the sessions
 * (`endAllAccessPage`), and writes the audit row. The API tokens stay, and
 * work again after an unban. A ban of a banned user replaces the time, the
 * reason, and the end.
 *
 * The whole invocation fits `OPERATOR_CALL_BUDGET`, the steps after the
 * commit too (rulings 37 and 44 of plan 12f). The sessions that do not fit
 * stay with a pending-end row, and the sweep ends them with `banned`.
 * Until then `bannedFor` refuses each of them at every door. A throw of
 * `endFamilies` after the commit answers ok with `familyEndFailed: true`.
 * The act also ends the impersonation sessions that the user opened as an
 * operator (`endImpersonations`, ruling 31).
 *
 * After the commit, in the order of ruling 2: `session.afterEnd` with
 * `banned` per session, `user.afterUpdate`, then `afterAction` and
 * `endFamilies` in `operatorAct`. The ban sends no back-channel logout in
 * its call: the outbox rows are due now, and the sweep sends them (ruling
 * 37 of plan 12f).
 */
export async function banUser(
  config: ResolvedConfig,
  input: BanInput,
): Promise<Result<{ auditId: string; familyEndFailed?: true }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const now = config.clock.now();
  const until = banEnd(input.until, now);
  if (!until.ok) return until;
  const fixed = TARGET_CALLS[input.actor.kind];
  const budget = await workBudget(
    config.storage,
    input.actor,
    undefined,
    fixed + STEP_WORST.hold + ACCESS_END_LEAST,
  );
  if (!budget.ok) return budget;
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
  const stops = impersonationStops(config, "ban");
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, _draft, ends: OperatorActEnds) => {
      const meter = meterOf(tx, fixed);
      const written = await writeBanFields(
        config,
        tx,
        input.userId,
        () => ({ bannedAt: now, banReason: reason.value, banUntil: until.value }),
        "ban",
        now,
      );
      if (!written.ok) return written;
      // The read and the update: a batch of 2 on D1.
      meter.step(STEP_WORST.hold);
      // The locks of the user's sessions and of the impersonation sessions
      // that the user opened, in one read, before any delete (ruling 42 L3):
      // the audit read and the lock read.
      const hold = await holdImpersonations(tx, config, input.userId, now, true);
      meter.step(2);
      // The impersonation sessions first, inside the budget (rulings 31 and 44).
      await endImpersonationsPage(
        tx,
        config,
        hold,
        ends,
        now,
        meter,
        budget.value,
        "banned",
        stops,
      );
      await endAllAccessPage(
        tx,
        config,
        input.userId,
        ends,
        now,
        meter,
        budget.value,
        "banned",
        stops,
      );
      return written;
    },
    {
      async committed(value, ends) {
        await sessionsEnded(config, ends.ended, "banned", stops);
        await userUpdated(config, value, "ban");
      },
      answerFamilyEnd: true,
    },
  );
  if (!done.ok) return done;
  const { auditId, familyEndFailed } = done.value;
  return ok(familyEndFailed ? { auditId, familyEndFailed } : { auditId });
}

/**
 * Lifts a ban (spec 26 item 5), with the audit row in the same transaction.
 * While a ban is active, the unban writes `banUntil` = now and keeps
 * `bannedAt` and `banReason` (ruling 28). So `bannedFor` still ends each
 * credential from before the unban: no session that the ban ended, and no
 * race row, comes back. With no active ban it writes no ban field, so an
 * ended timed ban keeps its own end. An unban of a user with no ban
 * answers ok and writes its row, because the operator's intent is a record.
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
        (previous) => (activeBan(previous, now) ? { banUntil: now } : {}),
        "unban",
        now,
      ),
    { committed: (value) => userUpdated(config, value, "unban") },
  );
  if (!done.ok) return done;
  return ok({ auditId: done.value.auditId });
}
