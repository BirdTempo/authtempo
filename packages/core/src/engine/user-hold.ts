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
 * The operator acts that end the sessions of a user keep one lock order
 * (plan 12f, final review L1). First comes this user row. Then comes
 * `holdImpersonations`, the one read that locks the sessions of the user
 * and of each impersonation target. Then come the member rows and the
 * owner lock. The ban, the revoke of the platform role, and `withRoleLoss`
 * all take them in that order. So two acts on a shared target wait, and
 * do not deadlock.
 *
 * No row returns: a sign-up writes its user later, and a deleted user is
 * found by `userStays`, the read after the insert. A stop here would answer
 * the same `conflict` on both stores, so the one check is that read.
 */
export async function holdUser(storage: StorageAdapter, userId: string): Promise<void> {
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
  console.error("authtempo: user hold gave up", userId);
  stopWith("conflict");
}

/** The read after an insert: `conflict` when an account delete took the user. */
export async function userStays(storage: StorageAdapter, userId: string): Promise<void> {
  if (!(await storage.findOne("user", [{ field: "id", op: "eq", value: userId }])))
    stopWith("conflict");
}
