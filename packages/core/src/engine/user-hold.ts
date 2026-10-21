import type { Observer } from "../observe/observer.js";
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
 * of plan 12k. The order has seven kinds of rows:
 *
 * 1. this user row (`holdUser`);
 * 2. the session rows: `holdSessions`, or `holdImpersonations`, the one
 *    read that locks the sessions of the user and of each impersonation
 *    target;
 * 3. the organization row: the stamp of `ownerLock`, or `lockOrganization`;
 * 4. the team row: `lockTeam`, or its delete;
 * 5. the invitation rows;
 * 6. the member rows;
 * 7. the team member rows.
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
 * team rows among them. So the team member add and the invitation accept
 * hold the user before the team lock. With the team lock first, an add of
 * the sole member beside the account delete formed a deadlock. A member
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
 * The role create takes the organization lock before its count, and no
 * user hold. The user token create holds the user row before its count of
 * the cap, and takes no other lock. The organization create holds the user
 * row before its count of `perUser` (ruling 45). The member add holds the
 * added user, then takes the organization lock before its count of
 * `membersPerOrganization`. The accept takes that lock after its user hold
 * and before its team locks. The invite takes it before its count of
 * `pendingInvitationsPerOrganization`, and no user hold.
 *
 * No row returns: a sign-up writes its user later, and a deleted user is
 * found by `userStays`, the read after the insert. A stop here would answer
 * the same `conflict` on both stores, so the one check is that read.
 */
export async function holdUser(
  observe: Observer,
  storage: StorageAdapter,
  userId: string,
): Promise<void> {
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  let row = await storage.findOne("user", byId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!row) return;
    const where: Where<"user">[] = [
      ...byId,
      { field: "updatedAt", op: "eq", value: row.updatedAt },
    ];
    if ((await storage.update("user", where, { updatedAt: row.updatedAt })) === 1) return;
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
