import type { ResolvedConfig } from "../../config.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type { UserRow } from "../../schema.js";
import { IN_CHUNK } from "../../storage/batch.js";
import { meterOf } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import {
  accountDeleted,
  DELETE_KEEP,
  type DeletedAccount,
  deleteAccountRows,
  ORGANIZATION_RULE_READS,
} from "../account-delete.js";
import { createSteps } from "../create-steps.js";
import { runAfter, runBefore, type UserPatch } from "../hooks.js";
import { organizationsOfDelete } from "../organizations.js";
import { sendResetLink } from "../password.js";
import { phoneRefusal } from "../phone.js";
import { unchanged } from "../profile.js";
import { ROUNDS } from "../rounds.js";
import { later } from "../second-factor.js";
import { mailUserInvite, writeUserInvite } from "../user-invite.js";
import { createUserIn, normalizeEmail, takenCode, validImageUrl, validUserName } from "../users.js";
import { SESSIONS_PAGE_LEAST } from "./access-end.js";
import { auditDraft, impersonationStops, operatorAct, operatorReason } from "./audit.js";
import { reasonOf, targetOf } from "./ban.js";
import { type OperatorActor, requireScope } from "./guards.js";
import { OPERATOR_CALLS_BEFORE, workBudget } from "./sessions.js";
import { type OperatorUser, operatorUsers } from "./users.js";

/**
 * The first sign-in of a created user (plan 12f2 Task 2). `invite` mails
 * an invitation link (Task 3), `reset` mails a reset link, and `none`
 * mails nothing.
 */
export type FirstSignIn = "invite" | "reset" | "none";

const FIRST_SIGN_INS: readonly unknown[] = ["invite", "reset", "none"];

/**
 * The input of an operator create (plan 12f2 Task 2). `email` is required
 * and may be null, so a caller states the case of no address on purpose.
 * A null address needs `phone` (owner decision 2 of 2026-10-15).
 */
export interface OperatorCreateUser {
  actor: OperatorActor;
  email: string | null;
  /** E.164. Needs the `phone` config of plan 12i. */
  phone?: string;
  /** False by default. True needs an address. */
  emailVerified?: boolean;
  name?: string | null;
  image?: string | null;
  /** `invite` by default with an address, `none` with no address. */
  firstSignIn?: FirstSignIn;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The input of an operator update (plan 12f2 Task 4). Each of `name` and
 * `image` is absent, a string under the profile rules of plan 12a, or null
 * to clear it. No other field: the address, `emailVerified`, and the
 * credentials have their own flows (spec 8.15).
 */
export interface OperatorUpdateUser {
  actor: OperatorActor;
  userId: string;
  name?: string | null;
  image?: string | null;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/** The input of an operator delete (plan 12f2 Task 4). */
export interface OperatorDeleteUser {
  actor: OperatorActor;
  userId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The calls of the per-actor limiter that the route of each act runs after
 * the actor read (plan 12f2 Task 5). The budget counts it now, so the act
 * fits when the route comes.
 */
const ACT_LIMIT_CALLS = 1;

/**
 * The least work of a delete, in storage calls at the worst. The delete
 * has no `targetOf`: the lock of the user row reads the target, and the
 * organization rule reads its platform role (ruling 5 of plan 12f2). The
 * lock of the user row is a read and an update, a batch of 2 on D1.
 * `holdImpersonations` is the audit read and the lock read. The
 * organization rule reads the member rows once. Then the user delete, the
 * deletes of the invitations and the member rows, the least page of the
 * own sessions, and `DELETE_KEEP`.
 */
const DELETE_LEAST = 3 + 2 + 1 + 1 + 2 + SESSIONS_PAGE_LEAST + DELETE_KEEP;

/** A parallel create took the address or the number first: mapped after the transaction (spec 8.14 item 6). */
function taken(err: unknown): Result<never> {
  const code = takenCode(err);
  if (code === null) throw err;
  return fail(code);
}

/**
 * Creates a user for a person (plan 12f2 Task 2, spec 26), with an address
 * or with a phone number only. The order of the checks: the tool is on,
 * the actor holds `users`, then the reason. The scope check comes before
 * any read of the input and any storage read, so a caller with no scope
 * learns nothing about an address (Review Focus 1). Then the address, the
 * name, the image, the phone, `emailVerified`, and `firstSignIn`; each
 * refusal answers `invalid_body`, `phone_invalid`, or `phone_region`.
 *
 * A user with no address needs a phone, and its first sign-in is the phone
 * code: no SMS goes out at create. A phone on an address needs
 * `emailVerified: true`, because a proof of the address clears the phone
 * (`claimEmail`, plan 12i). A user with neither has no way in.
 *
 * The create does not read `signUp` (plan 12b): it is the provisioning path
 * of an app whose self sign-up is closed. The operator, not a stranger,
 * creates the user.
 *
 * In one transaction with the audit row `user_create`: `createUserIn` with
 * `user.beforeCreate` and `via: "operator"`. A taken address or number
 * answers `email_taken` or `phone_taken` before any write; the loser of a
 * race maps by `takenCode` after the transaction. Either way no audit row
 * stays and no mail goes out, so an actor cannot mail any person.
 *
 * `invite` writes the invitation row in the same transaction (Task 3).
 *
 * After the commit: `user.afterCreate`, then the mail. `invite` mails the
 * invitation link (`mailUserInvite`). `reset` mails a
 * reset link (`sendResetLink`) with no limit of the reset route: the
 * operator limit of the route bounds both. The mail runs before the
 * answer, because the answer says what was mailed; the caller already
 * knows that the account exists. A mail that throws writes one
 * log line with no address, keeps the user, and answers `mailed: null`.
 * The audit `data` holds flags only, never the address, the phone, or the
 * name. The answer holds no token, no link, and no code.
 */
export async function createUser(
  config: ResolvedConfig,
  input: OperatorCreateUser,
): Promise<Result<{ userId: string; mailed: "invite" | "reset" | null; auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  let email: string | null = null;
  if (input.email !== null) {
    email = typeof input.email === "string" ? normalizeEmail(input.email) : null;
    if (email === null) return fail("invalid_body");
  }
  if (input.name != null && (typeof input.name !== "string" || !validUserName(input.name)))
    return fail("invalid_body");
  if (input.image != null && (typeof input.image !== "string" || !validImageUrl(input.image)))
    return fail("invalid_body");
  const emailVerified = input.emailVerified ?? false;
  if (typeof emailVerified !== "boolean") return fail("invalid_body");
  const firstSignIn = input.firstSignIn ?? (email === null ? "none" : "invite");
  if (!FIRST_SIGN_INS.includes(firstSignIn)) return fail("invalid_body");
  if (input.phone !== undefined) {
    if (typeof input.phone !== "string" || config.phone === null) return fail("invalid_body");
    const refused = phoneRefusal(config, input.phone);
    if (refused) return fail(refused);
  }
  // Neither handle: the user would have no way in and no path to a first proof.
  if (email === null && input.phone === undefined) return fail("invalid_body");
  if (email === null && (emailVerified || firstSignIn !== "none")) return fail("invalid_body");
  if (firstSignIn === "reset" && !config.password) return fail("invalid_body");
  // A proof of the address clears the phone (`claimEmail`), so a phone needs a proved address.
  if (input.phone !== undefined && email !== null && !emailVerified) return fail("invalid_body");
  const now = config.clock.now();
  const userId = newId(now);
  const drafted = auditDraft(input.actor, {
    action: "user_create",
    targetUserId: userId,
    reason: reason.value,
    data: {
      emailVerified,
      firstSignIn,
      hasAddress: email !== null,
      hasPhone: input.phone !== undefined,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const steps = createSteps(config, "operator", { signUpRule: false });
  // The clear invitation token, kept out of the work's value: that value
  // reaches the steps of the act, and the token leaves core only in the mail.
  let invite: string | null = null;
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx) => {
      steps.begin();
      invite = null;
      const made = await createUserIn(
        tx,
        steps,
        {
          id: userId,
          email,
          emailVerified,
          name: input.name ?? null,
          image: input.image ?? null,
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
        },
        now,
      );
      if (!made.ok) return made;
      const user = made.value;
      // The invitation row commits with the user and the audit row (plan 12f2 Task 3).
      if (firstSignIn === "invite" && user.email !== null)
        invite = await writeUserInvite(tx, config, { ...user, email: user.email }, now);
      return ok({ user });
    },
    { committed: (value) => steps.after(value.user) },
  ).catch(taken);
  if (!done.ok) return done;
  const { user, auditId } = done.value;
  let mailed: "invite" | "reset" | null = null;
  const token: string | null = invite;
  if (user.email !== null && (firstSignIn === "reset" || token !== null)) {
    try {
      if (token !== null) {
        await mailUserInvite(config, user.email, token);
        mailed = "invite";
      } else {
        await sendResetLink(config, user.email, undefined, config.clock.now());
        mailed = "reset";
      }
    } catch (e) {
      config.observe.emit({ name: "operator.create_mail_failed", userId: user.id, errorName: e });
    }
  }
  return ok({ userId: user.id, mailed, auditId });
}

/**
 * Corrects the name or the image of a user (plan 12f2, spec 26 and 8.15).
 * The order of the checks: the tool is on, the actor holds `users`, the
 * reason, the fields, then the target (`targetOf`). A user actor on their
 * own user answers `operator_self`; on another platform operator,
 * `operator_required`. A secret and the app can act on both.
 *
 * In one transaction with the audit row: `user.beforeUpdate` with `via:
 * "operator"`, then a compare-and-set of the user row, the form of the
 * profile update (`unchanged`). A lost round reads the row again and runs
 * the hook again. After `ROUNDS` lost rounds the answer is `conflict`.
 * After the commit: `user.afterUpdate` with `via: "operator"`. No notice
 * mail: a name and an image are not credentials (spec 8.15 item 9). The
 * audit `data` names the changed fields, never a value.
 *
 * The whole invocation stays under `OPERATOR_CALL_BUDGET` with no budget
 * check, because its cost has a fixed bound. At the worst, a user actor
 * through the route costs 9 before the act, 1 ready check, and 1 limiter.
 * The act costs 3 for the target, 1 read, 2 calls per round in 5 rounds,
 * the audit row, and 5 for the answer (`operatorUsers`). That is 31.
 */
export async function updateUser(
  config: ResolvedConfig,
  input: OperatorUpdateUser,
): Promise<Result<{ user: OperatorUser; auditId: string }>> {
  const reason = reasonOf(config, input);
  if (!reason.ok) return reason;
  const patch: Pick<UserPatch, "name" | "image"> = {};
  if (input.name !== undefined) {
    if (input.name !== null && (typeof input.name !== "string" || !validUserName(input.name)))
      return fail("invalid_body");
    patch.name = input.name;
  }
  if (input.image !== undefined) {
    if (input.image !== null && !validImageUrl(input.image)) return fail("invalid_body");
    patch.image = input.image;
  }
  const fields = Object.keys(patch);
  if (fields.length === 0) return fail("invalid_body");
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const drafted = auditDraft(input.actor, {
    action: "user_update",
    targetUserId: input.userId,
    reason: reason.value,
    data: { fields },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const now = config.clock.now();
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: input.userId }];
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx): Promise<Result<{ previous: UserRow; user: UserRow }>> => {
      let previous = await tx.findOne("user", byId);
      for (let round = 0; round < ROUNDS; round++) {
        if (!previous) return fail("not_found");
        // The hook runs before the write, so a stop leaves the row as it was on every adapter.
        await runBefore(config.observe, "user.beforeUpdate", config.hooks.user.beforeUpdate, {
          user: previous,
          patch,
          via: "operator",
        });
        const updatedAt = later(now, previous.updatedAt);
        if ((await tx.update("user", unchanged(previous), { ...patch, updatedAt })) === 1)
          return ok({ previous, user: { ...previous, ...patch, updatedAt } });
        previous = await tx.findOne("user", byId);
      }
      config.observe.emit({ name: "operator.update_gave_up", userId: input.userId });
      return fail("conflict");
    },
    {
      async committed(value) {
        await runAfter(
          config.observe,
          "user.afterUpdate",
          config.hooks.user.afterUpdate,
          { user: value.user, previous: value.previous, via: "operator" },
          value.user.id,
        );
      },
    },
  );
  if (!done.ok) return done;
  const [user] = await operatorUsers(config, [done.value.user]);
  if (!user) return fail("not_found");
  return ok({ user, auditId: done.value.auditId });
}

/**
 * The lock of the user row: the compare-and-set of the self delete
 * (`runDelete`), in a loop of `ROUNDS`. The answer holds the calls that it
 * made at the worst: each round is a read and an update, and an update in
 * a transaction is 2 statements on D1.
 */
async function lockUser(
  config: ResolvedConfig,
  tx: StorageAdapter,
  userId: string,
  now: Date,
): Promise<Result<{ user: UserRow; calls: number }>> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let seen = await tx.findOne("user", byId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!seen) return fail("not_found");
    const updatedAt = later(now, seen.updatedAt);
    if ((await tx.update("user", unchanged(seen), { updatedAt })) === 1)
      return ok({ user: { ...seen, updatedAt }, calls: 3 * (round + 1) });
    // A parallel write landed first. No write of this call has run.
    seen = await tx.findOne("user", byId);
  }
  config.observe.emit({ name: "account.delete_gave_up", userId });
  return fail("conflict");
}

/**
 * Deletes an account on a request (plan 12f2, spec 26 and 8.15). It needs
 * the scope `delete` (owner decision 3). A user actor holds every scope
 * (ruling 1 of plan 12f2, B7): the guard asked for a fresh session and a
 * second factor. A user actor on their own user answers `operator_self`:
 * the person has the self delete. On another platform operator it answers
 * `operator_required`. A secret and the app can delete a platform
 * operator, and the platform organization rule of 12a holds.
 *
 * The person's controls of spec 8.15 do not apply: no `account.delete`,
 * no `account.deleteConfirm`, and no fresh rule of the target.
 *
 * In one transaction with the audit row: the lock of the user row, then
 * `deleteAccountRows`, the one list of the rows of a delete. A missing
 * user answers `not_found` at the lock. For a user actor, a target who
 * holds the platform role answers `operator_required` from the
 * organization rule, after the lock (ruling 5 of plan 12f2, L1). A read
 * before the transaction would miss a grant that commits in between. A
 * solo organization goes with the account. The last owner of an
 * organization with other members answers `sole_owner`. On a store with a
 * per-invocation query limit (D1), a delete whose least work cannot fit
 * the budget answers `delete_too_large` (ruling 1 of plan 12f2, Q3, and
 * ruling 5). Postgres, MySQL, SQLite, and memory have no such limit, so
 * they never refuse on size. On every store, more solo organizations than
 * one set-based delete takes answer `delete_too_large` before any write
 * (ruling 30 of plan 12d). Each refusal writes nothing and leaves no
 * audit row. The sessions end in pages, and the sweep ends the rest with
 * `account_deleted`. The audit `data` is `{ organizations }`, and the row
 * keeps no address.
 *
 * After the commit come the steps of `accountDeleted`, with no IP and no
 * user agent in the notice (12f deviation 13) and no back-channel logout:
 * the sweep sends the outbox rows (ruling 37 of plan 12f).
 *
 * The budget counts the whole invocation (ruling 1 of plan 12f2, B2): the
 * calls before the act of `OPERATOR_CALLS_BEFORE`, the per-actor limiter
 * of the route, the read of the memberships, the ready check, the work,
 * and the audit row. On D1 the solo organizations cost 6 calls for any
 * count, and each organization that the user owns with another owner
 * costs 3. A user actor fits 1 solo organization and none of those; a
 * secret fits 1 solo organization and 3 (measured 2026-10-25).
 */
export async function deleteUser(
  config: ResolvedConfig,
  input: OperatorDeleteUser,
): Promise<Result<{ organizations: string[]; auditId: string }>> {
  if (!config.operator?.users) return fail("not_found");
  const scoped = requireScope(input.actor, "delete");
  if (!scoped.ok) return scoped;
  const reason = operatorReason(input.reason);
  if (!reason.ok) return reason;
  if (typeof input.userId !== "string") return fail("invalid_body");
  if (input.actor.kind === "user" && input.actor.user.id === input.userId)
    return fail("operator_self");
  // Before any write (ruling 30 of plan 12d), more solo organizations than
  // one set-based delete takes answer delete_too_large, as in the self
  // delete (`runDelete`). On D1 the undo of a write is no lock. One read of
  // the memberships decides: with at most IN_CHUNK of them, no count of
  // solo organizations passes it. The rule runs again in the transaction.
  const memberships = await config.storage.findMany("member", [
    { field: "userId", op: "eq", value: input.userId },
  ]);
  let checked = 1;
  if (memberships.length > IN_CHUNK) {
    const plan = await organizationsOfDelete(config, config.storage, input.userId);
    if (!plan.ok && plan.code === "delete_too_large") return plan;
    checked += ORGANIZATION_RULE_READS;
  }
  const before =
    OPERATOR_CALLS_BEFORE[input.actor.kind] +
    ACT_LIMIT_CALLS +
    checked +
    ((await config.storage.readyStatements?.()) ?? 1);
  const budget = await workBudget(config.storage, input.actor, before, DELETE_LEAST);
  if (!budget.ok) return budget;
  const sized = config.storage.queryLimitPerInvocation === true;
  const drafted = auditDraft(input.actor, {
    action: "user_delete",
    targetUserId: input.userId,
    reason: reason.value,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const now = config.clock.now();
  const stops = impersonationStops(config, "account_delete");
  // The count of the sessions that the pages ended (plan 12h Task 5).
  const counted = { sessions: 0 };
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, draft, ends): Promise<Result<DeletedAccount>> => {
      // No storage call of the act comes before its transaction.
      const meter = meterOf(tx, 0);
      if (stops) stops.rows.length = 0;
      counted.sessions = 0;
      const locked = await lockUser(config, tx, input.userId, now);
      if (!locked.ok) return locked;
      const { user } = locked.value;
      const going = await deleteAccountRows(tx, config, user, now, {
        sessionId: null,
        ended: ends.ended ?? null,
        stops,
        meter,
        counted,
        budget: budget.value,
        refuseAfter: sized ? locked.value.calls : null,
        refusePlatform: input.actor.kind === "user",
      });
      // The row is the last write of the act, so it can hold the ids.
      draft.data = { organizations: going.map((o) => o.id) };
      return ok({ user, going });
    },
    {
      committed: (value, ends) =>
        accountDeleted(config, value, {
          ended: ends.ended,
          stops,
          count: counted.sessions,
          ip: null,
          userAgent: null,
          logouts: false,
        }),
    },
  );
  if (!done.ok) return done;
  return ok({ organizations: done.value.going.map((o) => o.id), auditId: done.value.auditId });
}
