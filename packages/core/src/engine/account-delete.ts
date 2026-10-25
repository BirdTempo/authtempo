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
import { hasAddress } from "./address.js";
import { CONFIRM_PER_IP } from "./email-change.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { deliverLogouts } from "./oauth-logout.js";
import {
  endImpersonationsPage,
  endOwnSessionsPage,
  SESSIONS_PAGE_LEAST,
} from "./operator/access-end.js";
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
import { endedList, type ResolvedSession, sessionIsLive, sessionsEnded } from "./sessions.js";
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
 * the router (the session read), the rest of `resolveSession` (4), and the
 * limiter of the delete or of the confirm. `POST /user/delete` and its
 * confirm run no route limiter (verify-12f2-r10 Low A), so the list holds
 * none since plan 12f2.
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
 * read from the list, and 7 until plan 12f2 took the route limiter out.
 */
const DELETE_CALLS_BEFORE = 6;

/** The reads of `organizationsOfDelete` for any count of organizations (ruling 30 of plan 12d). */
export const ORGANIZATION_RULE_READS = 3;

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
 * With the impersonation tool on, the scenes sent 43, 45, 46, and 50, and
 * the confirm of the operator scene sent 51 (ruling 79 of plan 12d). Its
 * query 51 was the outbox read, so the logouts waited for the sweep. Ruling
 * 79 cut 1 call: `endSessions` reads the sessions once for the stop rows and
 * the hook list. Now the scenes send 42, 44, 45, and 49. The worst is the
 * confirm of the operator scene, with no SCIM Group or with 3: 50. Its list:
 * the ready check 1, the session read of the router 1, the rest of
 * `resolveSession` 4, the limiter 1, and the membership read 1. In the
 * transaction: the user lock 2, the spend of the link 1, the session of the
 * proof 1, the impersonation hold 1, the organization rule 3, the owner lock
 * 2, the user delete 1, the solo organizations 6, the invitation delete 1,
 * the member delete of the user 1, the owner recount 1, `endSessions` 4, the
 * page of the impersonation sessions 2, the scimUser read 1, and the 13
 * deletes of `LAST_MODELS`. After the commit: the verification delete 1 and
 * the outbox read 1. The pins are in operator-loss-budget.test.ts of
 * adapter-d1.
 *
 * Plan 12f2 (ruling 1, B1) ends the own sessions in `endOwnSessionsPage`, not
 * `endSessions`. With no hook the page sends 2 queries more than
 * `endSessions`. Its calls are its read, its link read, its delete, and the
 * last delete. The run of 2026-10-25 at the move of 12f2
 * onto main: the scenes send 42, 44, 45, and 47, and the confirm of the
 * operator scene 48, with no SCIM Group or with 3. In its list, the page of
 * the own sessions takes the place of `endSessions` 4. Each organization
 * that the user owns with another owner adds 3: the owner lock 2 and the
 * recount 1. With no size check the self delete of a due refresh passed 50
 * at 3 such organizations (51), so a size check refuses it (ruling 10 M1 of
 * plan 12f2).
 */

/**
 * The models that `deleteAccountRows` deletes by `userId` after the
 * sessions. The client links are not among them (ruling 78 of plan 12d,
 * ruling 1 of plan 12f2 item B1). The page of the sessions makes an outbox
 * row of each link that fits and deletes the link. The sweep
 * (`sweepLinks`) does the same for the other links, for the links of the
 * sessions that the page leaves once those sessions end, and for a link
 * that a parallel flow writes later. So a kept link lives until its
 * session ends and one round of `sweepLinks` over all links reaches it.
 * The D1 test of the operator delete sweeps until no link, no session, and
 * no outbox row of the user stays.
 */
const LAST_MODELS = USER_CHILD_MODELS.filter(
  (m) => m !== "session" && m !== "member" && m !== "oauthLogout" && m !== "oauthSessionClient",
);

/**
 * The calls of a delete after the pages of the sessions, at the worst. In
 * the transaction: the read and the delete of the scimGroupMember rows, and
 * one delete per model of `LAST_MODELS`. After the commit, 2 more. The self
 * delete makes the delete of the verification rows and the read of
 * `deliverLogouts`. The operator delete makes the same delete and sends one
 * notice mail, which counts as a subrequest on Workers Free (ruling 41 of
 * plan 12f).
 */
export const DELETE_KEEP = SCIM_GROUP_CALLS + LAST_MODELS.length + 2;

/**
 * The statements of the solo organizations in the act when one or more go,
 * for any count (rulings 30 and 78 of plan 12d): the organization,
 * connection, domain, and SCIM token deletes, the member delete with its
 * count, and one pending row. The operator delete reads it to refuse a
 * delete that cannot fit its budget.
 */
const SOLO_CALLS = 6;

/**
 * The part of `SOLO_CALLS` that `deleteOrganizationsHead` sends on D1: the
 * organization, connection, domain, and SCIM token deletes.
 */
const SOLO_HEAD_CALLS = 4;

/**
 * The statements of one `lockInOrder` at the worst: 2 on MySQL (ruling 2 of
 * plan 12g). The size check counts it only on a store that has the lock.
 */
const LOCK_CALLS = 2;

/**
 * A view of `tx` that counts its reads. Each `findOne` and `findMany` by
 * one value is one statement on every adapter. The size check of a delete
 * reads the count, because `statementsSent` also counts the statements of
 * a parallel invocation on the same adapter (ruling 35 of plan 12f).
 */
function readCounted(tx: StorageAdapter): { storage: StorageAdapter; reads(): number } {
  let reads = 0;
  const storage = new Proxy(tx, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key !== "findOne" && key !== "findMany") return value.bind(target);
      return (...args: unknown[]) => {
        reads++;
        return value.apply(target, args);
      };
    },
  });
  return { storage, reads: () => reads };
}

export interface AccountDelete {
  session: ResolvedSession;
  ip: string | null;
  userAgent: string | null;
}

/** The rows that a delete removed: the user row as the lock held it, and the organizations that went. */
export interface DeletedAccount {
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
 * A user with no address gets no mail (plan 12i, ruling 15 m3). Its proof
 * is the fresh session: a sign-in by a phone code, or a passkey
 * re-authentication, makes the session fresh. So its delete runs at once.
 */
export function startAccountDelete(
  config: ResolvedConfig,
  input: AccountDelete,
): Promise<Result<{ ok: true } | { sent: true }>> {
  return config.account.deleteConfirm && hasAddress(input.session.user)
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
  // Mail skips a user with no address (plan 12i): no link goes out, and the answer is the same.
  if (!hasAddress(user)) return ok({ sent: true });
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
 * `deleteAccountRows`. After the commit come the steps of `accountDeleted`.
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
  let checked = 1;
  if (memberships.length > IN_CHUNK) {
    const plan = await organizationsOfDelete(config, config.storage, userId);
    if (!plan.ok && plan.code === "delete_too_large") return plan;
    checked += ORGANIZATION_RULE_READS;
  }
  const before = DELETE_CALLS_BEFORE + checked + ((await config.storage.readyStatements?.()) ?? 1);
  // On a store with a per-invocation query limit (D1), a delete whose least
  // work cannot fit the budget answers delete_too_large before any delete
  // (ruling 1 of plan 12f2, Q3; ruling 10 M1). Each organization that the
  // user owns with another owner costs 3 calls, so the check counts them.
  const sized = config.storage.queryLimitPerInvocation === true;
  // The count of the user's sessions that the delete ended (plan 12h Task 5).
  const counted = { sessions: 0 };
  const done = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<DeletedAccount>> => {
      const meter = meterOf(tx, before);
      if (ended) ended.length = 0;
      if (stops) stops.rows.length = 0;
      counted.sessions = 0;
      // The first round starts from the user of the session, a read of this invocation
      // (ruling 78 of plan 12d). A row that changed since matches no row, and the round
      // reads it again.
      let seen: UserRow | null = input.session.user;
      let user: UserRow | null = null;
      // The calls of the lock at the worst: an update in a transaction is 2
      // statements on D1, the undo read and the update, and a lost round reads again.
      let calls = 0;
      for (let round = 0; round < ROUNDS && !user; round++) {
        if (!seen) return fail("not_found");
        const updatedAt = later(now, seen.updatedAt);
        calls += 2;
        if ((await tx.update("user", unchanged(seen), { updatedAt })) === 1)
          user = { ...seen, updatedAt };
        // A parallel write landed first. No write of this call has run.
        else {
          calls++;
          seen = await tx.findOne("user", byId);
        }
      }
      if (!user) {
        config.observe.emit({ name: "account.delete_gave_up", userId });
        return fail("conflict");
      }
      // The spend is one delete.
      if (spend) {
        await spend(tx, user, now);
        calls++;
      }
      const going = await deleteAccountRows(tx, config, user, now, {
        sessionId: input.session.session.id,
        ended: ended ?? null,
        stops,
        meter,
        counted,
        budget: OPERATOR_CALL_BUDGET,
        refuseAfter: sized ? before + calls : null,
        refusePlatform: false,
      });
      return ok({ user, going });
    }),
  );
  if (!done.ok) return done;
  await accountDeleted(config, done.value, {
    ended,
    stops,
    count: counted.sessions,
    ip: input.ip,
    userAgent: input.userAgent,
    logouts: true,
  });
  return ok({ ok: true });
}

/**
 * The steps after the commit of an account delete (ruling 1 of plan 12f2,
 * item B1). The self delete and the operator delete share them, so the
 * steps of a delete have one list. First the delete of the verification
 * rows of the user id and the address. A reset holds its link row before
 * the user row, so a delete inside the transaction could deadlock with it
 * on Postgres. Invitations to the address stay: they belong to the
 * organizations. Then `session.afterEnd`, the back-channel logouts when
 * `logouts` is true, the organization and user hooks, and the notice.
 *
 * The operator delete passes `logouts: false`: no operator act sends a
 * back-channel logout in its call (ruling 37 of plan 12f). Its outbox rows
 * are due now, and the sweep sends them.
 */
export async function accountDeleted(
  config: ResolvedConfig,
  deleted: DeletedAccount,
  after: {
    ended: SessionRow[] | undefined;
    stops: ImpersonationStops | null;
    count: number;
    ip: string | null;
    userAgent: string | null;
    logouts: boolean;
  },
): Promise<void> {
  const { user, going } = deleted;
  // The pending-end rows stay for the sweep (ruling 63 of plan 12f).
  await config.storage.delete("verification", [
    { field: "identifier", op: "in", value: [user.id, user.email] },
    { field: "purpose", op: "ne", value: "session-end" },
  ]);
  await sessionsEnded(config, after.ended, "account_deleted", after.stops, after.count);
  // Every outbox row of the user, also one that waits for a retry (ruling 78 of plan 12d).
  if (after.logouts) await deliverLogouts(config, user.id, true);
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
    ip: after.ip,
    userAgent: after.userAgent,
  });
}

/**
 * The rows of an account delete, after the lock of the user row (plan 12a
 * Tasks 11 and 20). The direct delete and the confirm share it, so the rows
 * of a delete have one list. Each refusal throws (`stopWith`), because the
 * lock wrote. It answers the organizations that go.
 *
 * The session of the proof is read again: a session that ended proves
 * nothing. The operator delete has no session of the user, so it passes
 * null and skips the read (ruling 1 of plan 12f2, item B1). Then
 * `holdImpersonations` locks the sessions, as user-hold.ts states. Then
 * the organization rule runs. With `refuseAfter`, a delete whose least
 * work cannot fit `budget` answers `delete_too_large` here, before any
 * delete (ruling 1 of plan 12f2, Q3). The self delete and the operator
 * delete pass it on a store with a per-invocation query limit (D1), and
 * null elsewhere (ruling 10 M1 of plan 12f2). Then the before hooks. The owner
 * lock of each organization that keeps another owner comes next.
 *
 * The deletes come in this order. First the user row, the solo
 * organizations, the invitations the user sent, and the member rows of the
 * user. Then the sessions, and every other row of `USER_CHILD_MODELS`. The
 * user row goes before the sessions: D1 has no lock, and a sign-in reads the
 * user row after its session insert. The sessions go before the
 * identities: a link in flight updates its session as its last statement,
 * so it undoes or commits first. On a store whose user delete cascades
 * (`userDeleteCascades`, the Better Auth tables), the user row and the
 * solo organization rows go after the member rows, the recount, and the
 * pages of the sessions (ruling 13 of plan 12f2). There no refusal comes
 * after a cascade, and the pages see the sessions.
 *
 * The solo organizations go set-based (rulings 30 and 78 of plan 12d): 6
 * storage calls for any count, 0 when none goes. The act deletes their
 * organization, connection, domain, SCIM token, and member rows, and one
 * pending row leaves the rest to the sweep (organization-rest.ts). The
 * organization rule reads in 3 calls for any count. At most `IN_CHUNK`
 * solo organizations go in one delete; more answer `delete_too_large`
 * before any write (`runDelete`).
 *
 * The sessions end in pages inside `budget` (ruling 1 of plan 12f2, item
 * B1): first the user's own sessions, then the impersonation sessions that
 * the user opened as an operator. The rows that do not fit stay, each set
 * with one pending-end row of the reason `account_deleted`, and the sweep
 * ends them. The doors refuse them before that: the user row is gone.
 */
export async function deleteAccountRows(
  tx: StorageAdapter,
  config: ResolvedConfig,
  user: UserRow,
  now: Date,
  proof: {
    /** The session of the user that proves the delete, or null for the operator delete. */
    sessionId: string | null;
    ended: SessionRow[] | null;
    stops: ImpersonationStops | null;
    meter: Meter;
    /** Takes the count of the sessions that the pages ended. */
    counted: { sessions: number };
    /** The calls of `meter` that the invocation may make. */
    budget: number;
    /**
     * Null: no size check (a store with no per-invocation query limit). A
     * number: the calls of `meter` that the caller made before this call, at
     * the worst. The reads of this call come on top. Then a delete
     * whose least work passes `budget` answers `delete_too_large`.
     */
    refuseAfter: number | null;
    /**
     * True for a user actor: a target who holds the platform role answers
     * `operator_required` (`organizationsOfDelete`, ruling 5 of plan 12f2).
     */
    refusePlatform: boolean;
  },
): Promise<OrganizationRow[]> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: user.id }];
  // The reads of this call up to the size check, counted one by one
  // (verify-12f2-r10 Low B): the proof session, the targets of the hold, and
  // the organization rule.
  const counted = readCounted(tx);
  if (proof.sessionId !== null) {
    const session = await counted.storage.findOne("session", [
      { field: "id", op: "eq", value: proof.sessionId },
    ]);
    if (!session || !sessionIsLive(config, session, now)) stopWith("unauthorized");
  }
  // The one read that locks the user's sessions and the impersonation
  // sessions that the user opened as an operator. It comes before the owner
  // lock, in the order of user-hold.ts (ruling 65 of plan 12f).
  const hold = await holdImpersonations(counted.storage, config, user.id, now, true);
  const plan = await organizationsOfDelete(config, counted.storage, user.id, proof.refusePlatform);
  if (!plan.ok) stopWith(plan.code);
  const { going, owned } = plan.value;
  // The least calls after this point, at the worst: the owner lock (a batch
  // of 2 on D1) and the recount of each organization that the user owns
  // with another owner, the user delete, the solo organizations, the deletes
  // of the invitations and the member rows of the user, the least of each
  // page of sessions, and `DELETE_KEEP`. The size check comes before the
  // scimUser locks, which D1 does not have.
  const least =
    3 * owned.length +
    1 +
    (going.length > 0 ? SOLO_CALLS : 0) +
    2 +
    SESSIONS_PAGE_LEAST * (hold.targets.length > 0 ? 2 : 1) +
    DELETE_KEEP;
  if (proof.refuseAfter !== null) {
    // The meter also counts the statements of a parallel invocation on the
    // same adapter, so it alone could refuse a delete that fits. The count
    // of this call's own statements caps it: its reads, and the lock of the
    // hold on a store that has one.
    const own = proof.refuseAfter + counted.reads() + (tx.lockInOrder ? LOCK_CALLS : 0);
    if (Math.min(proof.meter.used, own) + least > proof.budget) stopWith("delete_too_large");
  }
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
  const solo = organizationList(going.map((x) => x.id));
  // On a store whose user delete cascades (ruling 13 of plan 12f2), every
  // check that can refuse and the pages of the sessions run before the user
  // delete. Elsewhere the user row goes first: D1 has no lock, and a flow
  // that writes a row of the user reads the user row after its insert.
  const cascades = config.storage.userDeleteCascades === true;
  // The user row, then the rows of the solo organizations that give access or hold a
  // claim, set-based (rulings 30 and 78 of plan 12d). The rest waits for the sweep.
  const dropHead = async () => {
    await tx.delete("user", byId);
    if (solo.length > 0) await deleteOrganizationsHead(tx, solo, cascades);
  };
  if (cascades) {
    // The organization lock of user-hold.ts comes before the invitation and member rows.
    if (solo.length > 0)
      await tx.lockInOrder?.("organization", [{ field: "id", op: "in", value: solo }]);
  } else await dropHead();
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
  // `hold` came first. Each set ends in a page inside the call budget of the
  // invocation (ruling 63 of plan 12f, ruling 1 of plan 12f2). The rest stay
  // on a pending-end row for the sweep. The page of the own sessions keeps
  // to the budget only on a store with a per-invocation query limit (D1).
  // Postgres and MySQL send more statements than D1 for the same act (the
  // row locks), and they have no such limit. With the budget there, the
  // delete of an owner of a solo organization ended no own session in its
  // act, and each waited for the sweep. On a store whose user delete
  // cascades, the pages keep the calls of `dropHead` free too.
  const tail = cascades ? 1 + (solo.length > 0 ? SOLO_HEAD_CALLS : 0) : 0;
  const ownBudget =
    config.storage.queryLimitPerInvocation === true ? proof.budget : Number.POSITIVE_INFINITY;
  proof.counted.sessions = (
    await endOwnSessionsPage(
      tx,
      config,
      user.id,
      proof.ended,
      now,
      proof.meter,
      ownBudget,
      DELETE_KEEP + tail + (hold.targets.length > 0 ? SESSIONS_PAGE_LEAST : 0),
      "account_deleted",
      proof.stops,
    )
  ).ended;
  proof.counted.sessions += (
    await endImpersonationsPage(
      tx,
      config,
      hold,
      proof.ended,
      now,
      proof.meter,
      proof.budget,
      DELETE_KEEP + tail,
      "account_deleted",
      proof.stops,
    )
  ).ended;
  if (cascades) await dropHead();
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
