import type { ResolvedConfig } from "../config.js";
import { sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { oauthOf } from "./oauth-result.js";

/**
 * The end of a refresh family (rulings 40 and 43 of plan 12e). A family
 * ends by its end mark, then the delete of its rows. A new refresh row
 * reads the mark after its write, so no row of an ended family stays live.
 */

const DAY_MS = 86_400_000;

const FAMILY_END = "oauth-family-end";

/** The `valueHash` of the end mark of a family: the SHA-256 hex of `oauth-family-end:<familyId>`. */
const familyEndHash = (familyId: string) => sha256Hex(`${FAMILY_END}:${familyId}`);

/** True when a reuse, a revoke, or a delete of a grant ended the family (rulings 40 and 43 of plan 12e). */
export async function familyEnded(config: ResolvedConfig, familyId: string): Promise<boolean> {
  return (
    (await config.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await familyEndHash(familyId) },
      { field: "purpose", op: "eq", value: FAMILY_END },
    ])) !== null
  );
}

/**
 * Ends one authorization: it writes the end mark of the family, then
 * deletes every refresh row of the family (ruling 40 of plan 12e).
 *
 * Why a mark, not a row lock: D1 has no interactive transaction, so a lock
 * that spans two calls does not exist on every adapter. The mark needs only
 * what each adapter gives: a call outside a transaction commits before the
 * next call starts.
 *
 * The race it closes. A parallel request (the winner) writes a new row of
 * the family, then reads the mark (`stillGranted`). On Postgres, a DELETE
 * does not see a row that commits while the DELETE runs. Take the two
 * orders. The mark commits before the winner reads it: the winner sees it
 * and deletes its new row. Or the winner reads first. Then its new row
 * committed before the mark, so before the DELETE starts. The DELETE then
 * sees the row and deletes it. So in each order no row of the family is
 * live after the delete. A caller must not run this inside a transaction,
 * because the mark must commit before the DELETE starts.
 *
 * The mark lives `refreshTtlDays`, as long as the newest row of the family
 * can live. It holds the family id only, never a token.
 */
export async function revokeFamily(config: ResolvedConfig, familyId: string): Promise<void> {
  const now = config.clock.now();
  try {
    await config.storage.create("verification", {
      id: newId(now),
      purpose: FAMILY_END,
      identifier: familyId,
      valueHash: await familyEndHash(familyId),
      expiresAt: new Date(now.getTime() + oauthOf(config).refreshTtlDays * DAY_MS),
      consumedAt: null,
      data: null,
      // An unkeyed SHA-256: the version means nothing here.
      secretVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    // A second reuse of one family finds the mark there already.
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
  }
  await config.storage.delete("oauthToken", [{ field: "familyId", op: "eq", value: familyId }]);
}

/**
 * The families that a transaction deletes, to end after its commit (ruling
 * 43 of plan 12e). `scopes` holds each delete's where, so a second read
 * after the commit finds a family that a parallel request wrote meanwhile.
 */
export interface FamilyEnds {
  scopes: Where<"oauthToken">[][];
  ids: Set<string>;
}

export const familyEnds = (): FamilyEnds => ({ scopes: [], ids: new Set() });

/**
 * Inside a transaction: notes the families of the rows of `where`, then
 * deletes the rows. The caller calls `endFamilies` after the commit.
 */
export async function deleteFamilies(
  tx: StorageAdapter,
  where: Where<"oauthToken">[],
  ends: FamilyEnds,
): Promise<void> {
  for (const row of await tx.findMany("oauthToken", where)) ends.ids.add(row.familyId);
  ends.scopes.push(where);
  await tx.delete("oauthToken", where);
}

/**
 * After the commit of a transaction that ran `deleteFamilies`: reads each
 * scope again, then ends each family with `revokeFamily`. A delete inside
 * a transaction cannot end a family by itself. On Postgres, a refresh in
 * flight still sees its spent row until the commit. So it can write a new
 * row that the delete did not see. The mark of `revokeFamily` commits
 * before its own delete, so its argument covers that row too.
 */
export async function endFamilies(config: ResolvedConfig, ends: FamilyEnds): Promise<void> {
  for (const where of ends.scopes)
    for (const row of await config.storage.findMany("oauthToken", where))
      ends.ids.add(row.familyId);
  for (const id of ends.ids) await revokeFamily(config, id);
}
