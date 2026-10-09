import { fail, ok, type Result } from "../result.js";
import type { VerificationPurpose, VerificationRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";

export interface ConsumeInput {
  purpose: VerificationPurpose;
  /** The SHA-256 hex of the clear token. */
  valueHash: string;
  now: Date;
}

/**
 * Consumes a mailed row in one conditional update, so two clicks on the
 * same link race for one row and only one wins. One copy for every mailed
 * link: a third copy of a security check drifts.
 */
export async function consumeVerification(
  tx: StorageAdapter,
  input: ConsumeInput,
): Promise<Result<VerificationRow>> {
  const { now } = input;
  const row = await tx.findOne("verification", [
    { field: "valueHash", op: "eq", value: input.valueHash },
    { field: "purpose", op: "eq", value: input.purpose },
  ]);
  if (!row) return fail("invalid_token");
  const consumed = await tx.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (consumed !== 1) {
    // An unconsumed row past its expiry is expired. A consumed row, or one a
    // concurrent click consumed after our read, is invalid.
    const expired = row.consumedAt === null && row.expiresAt.getTime() <= now.getTime();
    return fail(expired ? "token_expired" : "invalid_token");
  }
  return ok(row);
}
