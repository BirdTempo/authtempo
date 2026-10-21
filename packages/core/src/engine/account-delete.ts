import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { organizationChange } from "../observe/events.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationRow, SessionRow, UserRow } from "../schema.js";
import { type Meter, meterOf } from "../storage/meter.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { USER_CHILD_MODELS } from "../storage/sql.js";
import { sendAccountMail } from "./account-mail.js";
import { CONFIRM_PER_IP } from "./email-change.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { deliverLogouts } from "./oauth-logout.js";
import { endImpersonationsPage } from "./operator/access-end.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { holdImpersonations } from "./operator/impersonation.js";
import { OPERATOR_CALL_BUDGET } from "./operator/sessions.js";
import {
  deleteOrganizationRows,
  organizationsOfDelete,
  ownersOf,
  publicOrganization,
} from "./organizations.js";
import { unchanged } from "./profile.js";
import { later, ROUNDS } from "./second-factor.js";
import {
  endedList,
  endSessions,
  type ResolvedSession,
  sessionIsLive,
  sessionsEnded,
} from "./sessions.js";
import { holdUser } from "./user-hold.js";

// Per hour, per user (plan 12a). A delete succeeds once. 5 lets a person
// retry after a `conflict` or after a fix of `sole_owner`, and bounds a loop.
export const DELETE_PER_USER = { seconds: 3600, max: 5 };

/** The prefix of the mailed confirm's token (plan 12a Task 20). */
export const DELETE_TOKEN_PREFIX = "ad_";
export const DELETE_TOKEN_RE = /^ad_[A-Za-z0-9_-]{43}$/;

/**
 * The calls of a delete invocation before its transaction, at the worst
 * (ruling 63 of plan 12f). Through the route: the impersonation step of
 * the router, the route limiter, `resolveSession` (3), and the limiter of
 * the delete or of the confirm. The ready check of the storage comes on
 * top. The D1 test `operator-loss-budget.test.ts` counts the whole
 * invocation on the binding.
 */
const DELETE_CALLS_BEFORE = 6;

/** The models that `deleteAccountRows` deletes by `userId` after the sessions. */
const LAST_MODELS = USER_CHILD_MODELS.filter(
  (m) => m !== "session" && m !== "member" && m !== "oauthLogout",
);

/**
 * The calls of a delete after the page of the impersonation sessions. In
 * the transaction: the outbox update and one delete per model of
 * `LAST_MODELS`. After the commit: the delete of the verification rows,
 * and the read of `deliverLogouts`.
 */
const DELETE_KEEP = 1 + LAST_MODELS.length + 2;

export interface AccountDelete {
  session: ResolvedSession;
  ip: string | null;
  userAgent: string | null;
}

interface Deleted {
  user: UserRow;
  going: OrganizationRow[];
}

/**
 * Deletes the account (plan 12a, spec 8.15). The fresh rule applies. With
 * `account.deleteConfirm` off, the fresh session is the proof, and the
 * delete runs at once.
 */
export async function deleteAccount(
  config: ResolvedConfig,
  input: AccountDelete,
): Promise<Result<{ ok: true }>> {
  if (!config.account.delete) return fail("not_found");
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  if (!(await config.limiter.allow(`user-delete:user:${input.session.user.id}`, DELETE_PER_USER)))
    return fail("rate_limited");
  return runDelete(config, input, null);
}

/**
 * `POST /user/delete` and `api.user.delete` (plan 12a Task 20). With
 * `account.deleteConfirm` on, the request mails a link and deletes nothing.
 * Else the delete runs at once. This is the one place of that choice.
 */
export function startAccountDelete(
  config: ResolvedConfig,
  input: AccountDelete,
): Promise<Result<{ ok: true } | { sent: true }>> {
  return config.account.deleteConfirm
    ? requestAccountDelete(config, input)
    : deleteAccount(config, input);
}

/**
 * The request of a mailed delete (plan 12a Task 20). Every check of the
 * direct delete runs first, in its order: `not_found` with `account.delete`
 * off, the fresh rule, the limit, and the sole-owner rule. Then, in one
 * transaction that holds the user row, the user's earlier links go and one
 * row holds the hash of a new `ad_` token. After the commit the link goes to
 * the user's address. It deletes nothing.
 */
export async function requestAccountDelete(
  config: ResolvedConfig,
  input: AccountDelete,
): Promise<Result<{ sent: true }>> {
  const confirm = config.account.deleteConfirm;
  if (!config.account.delete || !confirm) return fail("not_found");
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  const userId = input.session.user.id;
  if (!(await config.limiter.allow(`user-delete:user:${userId}`, DELETE_PER_USER)))
    return fail("rate_limited");
  // The rule runs again at the confirm: an owner can leave between the two.
  const plan = await organizationsOfDelete(config, config.storage, userId);
  if (!plan.ok) return plan;
  const now = config.clock.now();
  const token = randomToken(DELETE_TOKEN_PREFIX);
  const valueHash = await sha256Hex(token);
  // The hold of the user row (Task 11's holdUser) runs parallel requests of
  // one user one at a time on Postgres. A change of address holds the same
  // row, so the address read here is the one the link goes to.
  const held = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<UserRow>> => {
      await holdUser(config.observe, tx, userId);
      const user = await tx.findOne("user", [{ field: "id", op: "eq", value: userId }]);
      if (!user) return fail("not_found");
      // One live link per user: a new request ends the older ones.
      await tx.delete("verification", [
        { field: "purpose", op: "eq", value: "account-delete" },
        { field: "identifier", op: "eq", value: userId },
      ]);
      await tx.create("verification", {
        id: newId(now),
        purpose: "account-delete",
        identifier: userId,
        valueHash,
        expiresAt: new Date(now.getTime() + confirm.ttlMinutes * 60_000),
        consumedAt: null,
        data: null,
        createdAt: now,
        updatedAt: now,
        secretVersion: config.keyring.current,
      });
      return ok(user);
    }),
  );
  if (!held.ok) return held;
  const user = held.value;
  const link = `${config.baseURL}${config.basePath}/user/delete/confirm?token=${encodeURIComponent(token)}`;
  await sendAccountMail(config, {
    kind: "delete_confirm",
    email: user.email,
    link,
    ttlMinutes: confirm.ttlMinutes,
    appName: config.appName,
  });
  return ok({ sent: true });
}

/**
 * The confirm of a mailed delete (plan 12a Task 20). It needs a session of
 * the user who asked. The session need not be fresh: the request checked
 * that. In one transaction: the lock of the user row, the spend of the link
 * by one conditional update, then `deleteAccountRows`. The update matches
 * the hash, the user, no spend, and a live expiry. So a spent, expired, or
 * unknown link, and the link of another user, answer `invalid_token`.
 */
export async function confirmAccountDelete(
  config: ResolvedConfig,
  input: AccountDelete & { token: string },
): Promise<Result<{ ok: true }>> {
  if (!config.account.delete) return fail("not_found");
  if (typeof input.token !== "string" || !DELETE_TOKEN_RE.test(input.token))
    return fail("invalid_token");
  if (!(await config.limiter.allow(`user-delete-confirm:ip:${ipKey(input.ip)}`, CONFIRM_PER_IP)))
    return fail("rate_limited");
  const valueHash = await sha256Hex(input.token);
  return runDelete(config, input, async (tx, user, now) => {
    const spent = await tx.update(
      "verification",
      [
        { field: "valueHash", op: "eq", value: valueHash },
        { field: "purpose", op: "eq", value: "account-delete" },
        { field: "identifier", op: "eq", value: user.id },
        { field: "consumedAt", op: "eq", value: null },
        { field: "expiresAt", op: "gt", value: now },
      ],
      { consumedAt: now, updatedAt: now },
    );
    // The lock wrote, so the refusal throws to undo it.
    if (spent !== 1) stopWith("invalid_token");
  });
}

/** A step between the lock of the user row and the deletes: the spend of the confirm. */
type Spend = (tx: StorageAdapter, user: UserRow, now: Date) => Promise<void>;

/**
 * The delete, in one transaction (plan 12a Task 11). First the lock of the
 * user row through `unchanged()` (profile.ts), in a loop of `ROUNDS`. A
 * parallel change of address, a profile update, or a removal of a way in
 * then commits first or waits. A sign-in of a verified user holds the same
 * row (`prepareSession`). So its session commits before the delete reads
 * the sessions, or it sees the user gone. Then `spend`, then
 * `deleteAccountRows`.
 *
 * After the commit: the verification rows of the user id and the address.
 * A reset holds its link row before the user row, so a delete inside the
 * transaction could deadlock with it on Postgres. Invitations to the
 * address stay: they belong to the organizations.
 */
async function runDelete(
  config: ResolvedConfig,
  input: AccountDelete,
  spend: Spend | null,
): Promise<Result<{ ok: true }>> {
  const userId = input.session.user.id;
  const now = config.clock.now();
  const ended = endedList(config);
  const stops = impersonationStops(config, "account_delete");
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  const before = DELETE_CALLS_BEFORE + ((await config.storage.readyStatements?.()) ?? 1);
  const done = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<Deleted>> => {
      const meter = meterOf(tx, before);
      if (ended) ended.length = 0;
      if (stops) stops.rows.length = 0;
      let seen = await tx.findOne("user", byId);
      let user: UserRow | null = null;
      for (let round = 0; round < ROUNDS && !user; round++) {
        if (!seen) return fail("not_found");
        const updatedAt = later(now, seen.updatedAt);
        if ((await tx.update("user", unchanged(seen), { updatedAt })) === 1)
          user = { ...seen, updatedAt };
        // A parallel write landed first. No write of this call has run.
        else seen = await tx.findOne("user", byId);
      }
      if (!user) {
        config.observe.emit({ name: "account.delete_gave_up", userId });
        return fail("conflict");
      }
      if (spend) await spend(tx, user, now);
      const going = await deleteAccountRows(tx, config, user, now, {
        sessionId: input.session.session.id,
        ended: ended ?? null,
        stops,
        meter,
      });
      return ok({ user, going });
    }),
  );
  if (!done.ok) return done;
  const { user, going } = done.value;
  // The pending-end row of the operator stays for the sweep (ruling 63 of plan 12f).
  await config.storage.delete("verification", [
    { field: "identifier", op: "in", value: [user.id, user.email] },
    { field: "purpose", op: "ne", value: "session-end" },
  ]);
  await sessionsEnded(config, ended, "account_deleted", stops);
  // Every outbox row of the user, the older ones too: the delete made them due.
  await deliverLogouts(config, user.id);
  for (const organization of going) {
    await runAfter(
      config.observe,
      "organization.afterDelete",
      config.hooks.organization.afterDelete,
      { organization: publicOrganization(organization), user },
      organization.id,
    );
    config.observe.emit(organizationChange("afterDelete", organization.id));
  }
  await runAfter(
    config.observe,
    "user.afterDelete",
    config.hooks.user.afterDelete,
    { user },
    user.id,
  );
  // To the address of the row that the delete held, after the commit (plan 12a Task 6).
  await sendNotice(config, {
    event: "account_deleted",
    email: user.email,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ ok: true });
}

/**
 * The rows of an account delete, after the lock of the user row (plan 12a
 * Tasks 11 and 20). The direct delete and the confirm share it, so the rows
 * of a delete have one list. Each refusal throws (`stopWith`), because the
 * lock wrote. It answers the organizations that go.
 *
 * The session of the proof is read again: a session that ended proves
 * nothing. Then `holdImpersonations` locks the sessions, as user-hold.ts
 * states. Then the organization rule runs, and the before hooks. The owner
 * lock of each organization that keeps another owner comes next.
 *
 * The deletes come in this order. First the user row, the solo
 * organizations, the invitations the user sent, and the member rows of the
 * user. Then the sessions, and every other row of `USER_CHILD_MODELS`. The
 * user row goes before the sessions: D1 has no lock, and a sign-in reads the
 * user row after its session insert. The sessions go before the
 * identities: a link in flight updates its session as its last statement,
 * so it undoes or commits first.
 *
 * The cost per organization that goes: the 9 storage calls of
 * `deleteOrganizationRows` with `alone`. Plan 12k Task 8 added 2 of them,
 * the deletes of the organization tokens and of the role rows.
 */
export async function deleteAccountRows(
  tx: StorageAdapter,
  config: ResolvedConfig,
  user: UserRow,
  now: Date,
  proof: {
    sessionId: string;
    ended: SessionRow[] | null;
    stops: ImpersonationStops | null;
    meter: Meter;
  },
): Promise<OrganizationRow[]> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: user.id }];
  const session = await tx.findOne("session", [{ field: "id", op: "eq", value: proof.sessionId }]);
  if (!session || !sessionIsLive(config, session, now)) stopWith("unauthorized");
  // The one read that locks the user's sessions and the impersonation
  // sessions that the user opened as an operator. It comes before the owner
  // lock, in the order of user-hold.ts (ruling 65 of plan 12f).
  const hold = await holdImpersonations(tx, config, user.id, now, true);
  const plan = await organizationsOfDelete(config, tx, user.id);
  if (!plan.ok) stopWith(plan.code);
  const { going, owned } = plan.value;
  for (const organization of going)
    await runBefore(
      config.observe,
      "organization.beforeDelete",
      config.hooks.organization.beforeDelete,
      {
        organization: publicOrganization(organization),
        user,
      },
    );
  await runBefore(config.observe, "user.beforeDelete", config.hooks.user.beforeDelete, {
    user,
    organizations: going.map((x) => x.id),
  });
  // The lock of `ownerWrite`: a parallel owner removal holds it first,
  // or waits and then matches no row.
  for (const organization of owned) {
    const held = await tx.update(
      "organization",
      [
        { field: "id", op: "eq", value: organization.id },
        { field: "updatedAt", op: "eq", value: organization.updatedAt },
      ],
      { updatedAt: later(now, organization.updatedAt) },
    );
    if (held === 0) stopWith("conflict");
  }
  await tx.delete("user", byId);
  for (const organization of going) await deleteOrganizationRows(tx, organization.id, user.id);
  // The invitations come before the member rows, in the order of user-hold.ts
  // (ruling 50 of plan 12k).
  await tx.delete("invitation", [{ field: "inviterId", op: "eq", value: user.id }]);
  await tx.delete("member", [{ field: "userId", op: "eq", value: user.id }]);
  // D1 has no lock: the recount catches an owner removal that passed the lock.
  for (const organization of owned)
    if ((await ownersOf(config, tx, organization.id)) < 1) stopWith("conflict");
  // The user's sessions and the impersonation sessions that the user opened
  // as an operator go together (ruling 42 of plan 12f). The lock read of
  // `hold` came first.
  await endSessions(
    tx,
    [{ field: "userId", op: "eq", value: user.id }],
    proof.ended,
    now,
    proof.stops,
  );
  // A page of them ends inside the call budget of the invocation (ruling 63
  // of plan 12f). The rest stay on a pending-end row for the sweep.
  await endImpersonationsPage(
    tx,
    config,
    hold,
    proof.ended,
    now,
    proof.meter,
    OPERATOR_CALL_BUDGET,
    DELETE_KEEP,
    "account_deleted",
    proof.stops,
  );
  // The back-channel outbox stays (plan 12e Task 16, review I3 of Task 1).
  // Its rows are the logouts of this delete, and of earlier ends that wait
  // for a retry. Each one is due now, so the delivery after the commit sends
  // them. A row goes when it is sent, or after its last attempt.
  await tx.update(
    "oauthLogout",
    [
      { field: "userId", op: "eq", value: user.id },
      { field: "nextAttemptAt", op: "gt", value: now },
    ],
    { nextAttemptAt: now, updatedAt: now },
  );
  for (const model of USER_CHILD_MODELS) {
    if (model === "session" || model === "member" || model === "oauthLogout") continue;
    // Each model of the list has a `userId` field: USER_CHILD_MODELS reads
    // the schema. The port's types cannot see that over a union of models.
    await tx.delete(model, [{ field: "userId", op: "eq", value: user.id }] as never);
  }
  return going;
}
