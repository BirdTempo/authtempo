import type { D1Subset } from "@authtempo/adapter-d1/seam";
import { StorageError } from "@authtempo/core";

const SETTING =
  "the driver reads integers as BigInt; open the database without readBigInts, safeIntegers, or intMode bigint";

/**
 * The check that the handle reads an integer as a number (plan 12g). The
 * decode rules of core read numbers, so a handle that answers BigInt breaks
 * dates, counts, and flags. The check runs once. A failed check is not kept,
 * as the version gate's rule, so the next call reads again.
 */
export function integerProbe(
  db: D1Subset,
  sent: { statements: number; ready?: number },
): () => Promise<void> {
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        // The query counts in `statementsSent` and in `readyStatements`, as the
        // version check's query does (rulings 35 and 37 of plan 12f).
        sent.statements++;
        if (sent.ready !== undefined) sent.ready++;
        const n = await db.prepare("SELECT 1 AS n").first("n");
        if (typeof n !== "number") throw new StorageError("config_mismatch", "meta", [SETTING]);
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}
