import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { organizationChange } from "../observe/events.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationRow, SessionRow, UserRow } from "../schema.js";
import { IN_CHUNK } from "../storage/batch.js";
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
import { deferOrganizationRest } from "./organization-rest.js";
import {
  deleteOrganizationsHead,
  organizationList,
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
 * the router (the session read), the route limiter, the rest of
 * `resolveSession` (4), and the limiter of the delete or of the confirm.
 * The handler's session read takes the row of the router (ruling 78 of
 * plan 12d), so the rest of the worst caller session is 4: the user, the
 * pending-end read of ruling 50 of plan 12d, the session-cap read of a due
 * refresh with `sso.saml` on (ruling 44 of plan 12d), and the refresh
 * (ruling 51 of plan 12d). The ready check of the storage comes on top.
 * The D1 test `operator-loss-budget.test.ts` counts the whole invocation
 * on the binding. A page of impersonation sessions needs 3 calls at the
 * least. So only a scene that leaves the page 2 calls at 8 shows the step
 * from 7. The run of 2026-10-22, with a due refresh and `sso.saml` on,
 * gave the page -1, 1, or 3 calls in four scenes: a direct delete or a
 * confirm, with a `session.afterEnd` hook or without. Each count was the
 * same at 7 and at 8. So the value is the sum of the list above, not a
 * measured step: 8 until ruling 78 of plan 12d took the second session
 * read from the list.
 */
const DELETE_CALLS_BEFORE = 7;

/**
 * The read of the user's scimUser rows and the delete of their
 * scimGroupMember rows (ruling 25 of plan 12d). A user has one scimUser row
 * per organization, and one delete takes `IN_CHUNK` of them. The reserve
 * holds the read and one delete.
 */
const SCIM_GROUP_CALLS = 2;

/*
 * The queries of `POST /user/delete` by the owner of one solo organization,
 * through the route, on the D1 binding with the D1 limiter (ruling 78 of
 * plan 12d, measured 2026-10-24). D1 Free allows 50 queries per invocation
 * (D1 limits page updated 21 April 2026, read 2026-10-21). Before ruling 78
 * the scenes sent 55 (no refresh), 59 (a due refresh with `sso.saml` on),
 * 60 (the confirm of that scene), and 64 (an operator with 40 impersonation
 * sessions in that scene). Ruling 78 cut 14 calls, in measured steps:
 *
 * - 1: the handler's session read takes the row of the router.
 * - 1: the lock of the user row starts from the user of the session.
 * - 2: the outbox update goes (2 on D1: the undo read and the update); the
 *   delivery after the commit sends every row of the user.
 * - 1: the client link delete goes; `endSessions` deleted every link of
 *   the user's sessions, and the sweep makes a logout of a later one.
 * - 9: the solo organizations keep 6 calls of 15 in the act: the
 *   organization, connection, domain, and SCIM token deletes, the member
 *   delete with its count, and one pending row. The SCIM Users and Groups,
 *   the teams, the invitations, the tokens, the roles, the team members, and
 *   the active organization of the sessions go at the sweep
 *   (organization-rest.ts). So a solo organization with SCIM Groups goes
 *   with the account too.
 *
 * With the impersonation tool on, the scenes send 43, 45, 46, and 50. The
 * list of the operator scene: the ready check 1, the session read of the
 * router 1, the rest of `resolveSession` 4, the limiter 1, and the
 * membership read 1. In the transaction: the user lock 2, the session of
 * the proof 1, the impersonation hold 1, the organization rule 3, the owner
 * lock 2, the user delete 1, the solo organizations 6, the invitation
 * delete 1, the member delete of the user 1, the owner recount 1,
 * `endSessions` 5, the page of the impersonation sessions 2, the scimUser
 * read 1, and the 13 deletes of `LAST_MODELS`. After the commit: the
 * verification delete 1 and the outbox read 1. The pins are in
 * operator-loss-budget.test.ts of adapter-d1.
 */

/**
 * The models that `deleteAccountRows` deletes by `userId` after the
 * sessions. The client links are not among them: `endSessions` makes each
 * link of the user's sessions an outbox row and deletes it, and the sweep
 * does the same for a link that a parallel flow writes later (ruling 78 of
 * plan 12d).
 */
const LAST_MODELS = USER_CHILD_MODELS.filter(
  (m) => m !== "session" && m !== "member" && m !== "oauthLogout" && m !== "oauthSessionClient",
);

/**
 * The calls of a delete after the page of the impersonation sessions. In
 * the transaction: the read and the delete of the scimGroupMember rows, and
 * one delete per model of `LAST_MODELS`. After the commit: the delete of
 * the verification rows, and the read of `deliverLogouts`.
 */
const DELETE_KEEP = SCIM_GROUP_CALLS + LAST_MODELS.length + 2;

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
  if (!(await limit(config, "user-delete:user", input.session.user.id, DELETE_PER_USER)))
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
  if (!(await limit(config, "user-delete:user", userId, DELETE_PER_USER)))
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
 * by one conditional delete, then `deleteAccountRows`. The delete matches
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
  if (!(await limit(config, "user-delete-confirm:ip", ipKey(input.ip), CONFIRM_PER_IP)))
    return fail("rate_limited");
  const valueHash = await sha256Hex(input.token);
  return runDelete(config, input, async (tx, user, now) => {
    // The spend deletes the link row (ruling 52 item 2 of plan 12d). An update costs 2
    // statements on D1, the undo read and the update; a delete costs 1. The rows of the
    // user go after the commit anyway, and an undo writes the row back.
    const spent = await tx.delete("verification", [
      { field: "valueHash", op: "eq", value: valueHash },
      { field: "purpose", op: "eq", value: "account-delete" },
      { field: "identifier", op: "eq", value: user.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ]);
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
  // Before any write (ruling 30 of plan 12d), more solo organizations than
  // one set-based delete takes answer delete_too_large. The check is also
  // for D1, where the undo of a write is no lock. One read of the
  // memberships decides:
  // with at most IN_CHUNK of them, no count of solo organizations passes it.
  // The rule runs again inside the transaction, after the lock of the user.
  const memberships = await config.storage.findMany("member", [
    { field: "userId", op: "eq", value: userId },
  ]);
  if (memberships.length > IN_CHUNK) {
    const plan = await organizationsOfDelete(config, config.storage, userId);
    if (!plan.ok && plan.code === "delete_too_large") return plan;
  }
  const before = DELETE_CALLS_BEFORE + 1 + ((await config.storage.readyStatements?.()) ?? 1);
  // The count of the user's sessions that the delete ended (plan 12h Task 5).
  const counted = { sessions: 0 };
  const done = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<Deleted>> => {
      const meter = meterOf(tx, before);
      if (ended) ended.length = 0;
      if (stops) stops.rows.length = 0;
      counted.sessions = 0;
      // The first round starts from the user of the session, a read of this invocation
      // (ruling 78 of plan 12d). A row that changed since matches no row, and the round
      // reads it again.
      let seen: UserRow | null = input.session.user;
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
        counted,
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
  await sessionsEnded(config, ended, "account_deleted", stops, counted.sessions);
  // Every outbox row of the user, also one that waits for a retry (ruling 78 of plan 12d).
  await deliverLogouts(config, user.id, true);
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
 * The solo organizations go set-based (rulings 30 and 78 of plan 12d): 6
 * storage calls for any count, 0 when none goes. The act deletes their
 * organization, connection, domain, SCIM token, and member rows, and one
 * pending row leaves the rest to the sweep (organization-rest.ts). The
 * organization rule reads in 3 calls for any count. At most `IN_CHUNK`
 * solo organizations go in one delete; more answer `delete_too_large`
 * before any write (`runDelete`).
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
    /** Takes the count of the user's sessions that `endSessions` answered. */
    counted: { sessions: number };
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
  // The scimUser rows come after the sessions and before the owner locks (ruling 74 M3 of
  // plan 12d): the user's own rows, and the rows of each solo organization.
  await tx.lockInOrder?.("scimUser", [{ field: "userId", op: "eq", value: user.id }]);
  if (going.length > 0)
    await tx.lockInOrder?.("scimUser", [
      { field: "organizationId", op: "in", value: going.map((x) => x.id).sort() },
    ]);
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
  // The rows of the solo organizations that give access or hold a claim go now, set-based
  // (rulings 30 and 78 of plan 12d). The rest waits for the sweep.
  const solo = organizationList(going.map((x) => x.id));
  if (solo.length > 0) await deleteOrganizationsHead(tx, solo);
  // The invitations come before the member rows, in the order of user-hold.ts
  // (ruling 50 of plan 12k).
  await tx.delete("invitation", [{ field: "inviterId", op: "eq", value: user.id }]);
  // One member row of the user in each solo organization: the unique key. One more is a
  // member who joined after the organization rule, so the organization is not the user's
  // alone. The throw undoes the act.
  if (
    solo.length > 0 &&
    (await tx.delete("member", [{ field: "organizationId", op: "in", value: solo }])) !==
      solo.length
  )
    stopWith("conflict");
  await tx.delete("member", [{ field: "userId", op: "eq", value: user.id }]);
  if (solo.length > 0) await deferOrganizationRest(tx, config, solo, now);
  // D1 has no lock: the recount catches an owner removal that passed the lock.
  for (const organization of owned)
    if ((await ownersOf(config, tx, organization.id)) < 1) stopWith("conflict");
  // The user's sessions and the impersonation sessions that the user opened
  // as an operator go together (ruling 42 of plan 12f). The lock read of
  // `hold` came first.
  proof.counted.sessions = await endSessions(
    tx,
    [{ field: "userId", op: "eq", value: user.id }],
    proof.ended,
    now,
    proof.stops,
  );
  // A page of them ends inside the call budget of the invocation (ruling 63
  // of plan 12f). The rest stay on a pending-end row for the sweep.
  proof.counted.sessions += (
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
    )
  ).ended;
  // The back-channel outbox stays (plan 12e Task 16, review I3 of Task 1).
  // Its rows are the logouts of this delete, and of earlier ends that wait
  // for a retry. The delivery after the commit sends them all, with no
  // update here (ruling 78 of plan 12d). A row goes when it is sent, or
  // after its last attempt. A row that fails waits for its next attempt.
  // A scimGroupMember row names a scimUser row, not the user, so it is no
  // user child model (ruling 25 of plan 12d). One read takes the user's
  // scimUser ids, and their member rows go before them.
  const scimUsers = await tx.findMany("scimUser", [{ field: "userId", op: "eq", value: user.id }]);
  for (let i = 0; i < scimUsers.length; i += IN_CHUNK)
    await tx.delete("scimGroupMember", [
      {
        field: "scimUserId",
        op: "in",
        value: scimUsers.slice(i, i + IN_CHUNK).map((r) => r.id),
      },
    ]);
  for (const model of LAST_MODELS) {
    // Each model of the list has a `userId` field: USER_CHILD_MODELS reads
    // the schema. The port's types cannot see that over a union of models.
    await tx.delete(model, [{ field: "userId", op: "eq", value: user.id }] as never);
  }
  return going;
}
