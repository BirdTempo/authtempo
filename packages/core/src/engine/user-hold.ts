import type { Observer } from "../observe/observer.js";
import type { UserRow } from "../schema.js";
import { findManyList, listChunks } from "../storage/batch.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { stopWith } from "./hooks.js";
import { ROUNDS } from "./rounds.js";

/**
 * The hold of the user row against the account delete (plan 12a Task 11).
 * A flow that writes a row that names a user holds that user row before its
 * writes, and reads it again after its insert. On Postgres the hold keeps
 * the row lock until the commit. A delete that starts later waits, and then
 * it sees the new row. A delete that started first makes the hold wait, and
 * then the row is gone. D1 has no lock. The delete removes the user row
 * first, and the flow reads the row after its insert. So one of the two
 * always sees the other.
 */

/**
 * Takes the lock of the user row. The write sets `updatedAt` to the value it
 * read, so it changes nothing, and a parallel compare-and-set still matches.
 * A flow takes it before its other writes, so the lock order is the same for
 * all. One kind of write comes first: the reset and the password change take
 * the pending reset rows of the address. So the account delete removes the
 * proofs after its commit, and no deadlock forms. The password change and
 * the gated reset take the user row before the password row, as the delete
 * does, so their old order (the password row, then the sessions) forms no
 * cycle with the delete. After `ROUNDS` lost rounds the answer is `conflict`.
 *
 * One lock order holds for every flow (rulings 49 and 50 of plan 12k). It
 * joins the order of plan 12f (final review L1) and the order of ruling 43
 * of plan 12k. The order has ten kinds of rows:
 *
 * 1. the scimGroup row of a SCIM group write (plan 12d Task 11);
 * 2. this user row (`holdUser`);
 * 3. the session rows: `holdSessions`, or `holdImpersonations`, the one
 *    read that locks the sessions of the user and of each impersonation
 *    target;
 * 4. the scimUser rows (ruling 74 M3 of plan 12d);
 * 5. the organization row: the stamp of `ownerLock`, or `lockOrganization`;
 * 6. the team row: `lockTeam`, or its delete;
 * 7. the invitation rows;
 * 8. the member rows;
 * 9. the scimGroupMember rows;
 * 10. the team member rows.
 *
 * A SCIM group write takes its scimGroup row first, so it orders two
 * writes of one group. The organization delete and the account delete lock
 * the scimGroup rows of their organizations first, and delete them later
 * (ruling 74 of plan 12d). A SCIM User write holds the user and the
 * sessions, then its scimUser row, then the organization lock of a
 * deprovision. So the organization delete and the account delete lock the
 * scimUser rows before the organization row: the other order formed a
 * deadlock on Postgres. A group write and a SCIM User delete take the member
 * rows before the scimGroupMember rows (ruling 59 M1 of plan 12d): the other
 * order formed a deadlock on Postgres. The account delete leaves the team
 * member rows of its solo organizations to the sweep (ruling 78 of plan
 * 12d), so it deletes the scimGroupMember rows of its user before every
 * team member row that it deletes.
 *
 * A flow can write a kind again after a later kind: it holds those rows
 * from the first time. No flow writes a kind first after a later kind. The
 * test lock-order-kinds.test.ts of adapter-postgres checks the flows that
 * write two kinds or more. Its source scan pins each transaction site of
 * this folder to such a flow or to a reason. The check sees kinds, not row
 * sets. A create holds only its new row, so the check skips it. The race
 * tests team-delete-gap-race.test.ts and organization-delete-gap-race.test.ts
 * of adapter-postgres cover the row-set gaps.
 *
 * The ban, the revoke of the platform role, `withRoleLoss`, and the account
 * delete lock the user's sessions with `holdImpersonations`, also with no
 * impersonation. A member removal and a leave lock the person's sessions
 * with `holdSessions`. Each of them writes these sessions after its member
 * or team member deletes. A team write locks the same sessions before its
 * team row, so the two run one at a time (rulings 48 and 49).
 *
 * The account delete takes the rows of each organization that goes, its
 * team rows among them: the act takes the organization and member rows,
 * and the sweep the rest (ruling 78 of plan 12d). So the team member add
 * and the invitation accept hold the user before the team lock. With the
 * team lock first, an add of the sole member beside the account delete
 * formed a deadlock. A member
 * removal holds the person's user row before the organization lock of
 * `ownerWrite` or of `revokeTokens`. So a removal and a team member add or
 * an accept of that person run one at a time.
 *
 * The team member removal, `setActiveTeam`, and the team delete take no
 * user hold. Each takes the locks of the sessions it writes first, then the
 * team lock. With `keepLastTeam`, the team delete takes the organization
 * lock between the two. The team member removal locks every session of the
 * person, so a set cannot move a session into the team after its lock
 * read. The team delete reads the sessions of the team again after its team
 * lock, and starts a new round when a set moved one in. The organization
 * delete does the same with the sessions that act in it and its
 * organization row. `setActiveOrganization` locks its session and then the
 * organization row, so no set moves a session into the organization after
 * that lock (ruling 50).
 *
 * `deleteOrganizationRows` deletes the organization row first and the team
 * rows next. So it waits for each flow that holds one of these locks, in
 * the same order. It deletes the member rows before the team member rows,
 * as a member removal and the account delete do (ruling 44). An accept that
 * raises a member takes the team lock before its member update. The accept
 * consumes its invitation after its team locks and before its member write.
 * The team delete and the account delete write the invitations before the
 * team member and member rows (ruling 50).
 *
 * The grant of the platform role, and a role change that adds its part,
 * hold the target's user row first, before the read of the member row. The
 * operator delete holds the same row before its read of the platform role,
 * so no grant lands between that read and its member delete (ruling 6 of
 * plan 12f2).
 *
 * The role create takes the organization lock before its count, and no
 * user hold. The user token create holds the user row before its count of
 * the cap, and takes no other lock. The organization create holds the user
 * row before its count of `perUser` (ruling 45). The member add holds the
 * added user, then takes the organization lock before its count of
 * `membersPerOrganization`. The accept takes that lock after its user hold
 * and before its team locks. The invite takes it before its count of
 * `pendingInvitationsPerOrganization`, and no user hold.
 *
 * No row returns null: a sign-up writes its user later, and a deleted user
 * is found by `userStays`, the read after the insert. A stop here would
 * answer the same `conflict` on both stores, so the one check is that read.
 * The answer is the row that the hold matched, so its fields are those
 * under the lock (ruling 78 of plan 12d).
 */
export async function holdUser(
  observe: Observer,
  storage: StorageAdapter,
  userId: string,
): Promise<UserRow | null> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let row = await storage.findOne("user", byId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!row) return null;
    const where: Where<"user">[] = [
      ...byId,
      { field: "updatedAt", op: "eq", value: row.updatedAt },
    ];
    if ((await storage.update("user", where, { updatedAt: row.updatedAt })) === 1) return row;
    // A parallel write moved the row first. Read it again.
    row = await storage.findOne("user", byId);
  }
  observe.emit({ name: "user.hold_gave_up", userId });
  stopWith("conflict");
}

/**
 * Takes the locks of the sessions of `userId`, by id, in the caller's
 * transaction. It comes after the hold of that user row and before the
 * organization row, in the order above. A member removal and a leave call
 * it. They clear the active organization and team of these sessions after
 * the member and team member deletes (ruling 49 of plan 12k). It costs one
 * statement on Postgres. D1 and memory have no row lock and leave it out.
 */
export async function holdSessions(storage: StorageAdapter, userId: string): Promise<void> {
  await storage.lockInOrder?.("session", [{ field: "userId", op: "eq", value: userId }]);
}

/** The read after an insert: `conflict` when an account delete took the user. */
export async function userStays(storage: StorageAdapter, userId: string): Promise<void> {
  if (!(await storage.findOne("user", [{ field: "id", op: "eq", value: userId }])))
    stopWith("conflict");
}

/**
 * The hold of many user rows at once, in the step of `holdUser` (ruling 25
 * N3 of plan 12d). A team member add of a SCIM group holds each added
 * user, and one hold per user would cost three statements each on D1. On
 * Postgres `lockInOrder` takes the row locks by `id` ascending, one
 * statement per 1000 users (ruling 84). So two flows that hold some of the same users
 * wait on each other in one order. D1 and memory have no row lock and leave
 * it out: the read after the inserts (`usersStay`) is the one check there,
 * as it is for `holdUser`.
 */
export async function holdUsers(
  storage: StorageAdapter,
  userIds: readonly string[],
): Promise<void> {
  // One statement per list of `listChunks`: up to 1000 users (ruling 84 of plan 12d).
  for (const ids of listChunks([...new Set(userIds)].sort()))
    await storage.lockInOrder?.("user", [{ field: "id", op: "in", value: ids }]);
}

/** The read after the inserts of `holdUsers`: `conflict` when an account delete took one of the users. */
export async function usersStay(
  storage: StorageAdapter,
  userIds: readonly string[],
): Promise<void> {
  const ids = new Set(userIds);
  if (ids.size === 0) return;
  if ((await findManyList(storage, "user", "id", [...ids])).length < ids.size) stopWith("conflict");
}
