import type { ResolvedConfig } from "../config.js";

export interface SweepResult {
  verificationExpired: number;
  verificationConsumed: number;
  invitations: number;
}

// A consumed verification row stays for one day. While it exists, a replayed token
// answers `invalid_token`. Without it, the replay would answer `token_expired` or
// find no row, and a flow that mints on a missing row could mint again.
const CONSUMED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Deletes rows that no flow can use any more. Call it from a scheduled handler. Safe to run at any time. */
export async function sweepExpired(config: ResolvedConfig): Promise<SweepResult> {
  const { storage } = config;
  const now = config.clock.now();
  const graceEnd = new Date(now.getTime() - CONSUMED_GRACE_MS);
  // The port has no OR, so each condition is one statement.
  const verificationExpired = await storage.delete("verification", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  const verificationConsumed = await storage.delete("verification", [
    { field: "consumedAt", op: "lt", value: graceEnd },
  ]);
  const accepted = await storage.delete("invitation", [
    { field: "acceptedAt", op: "ne", value: null },
  ]);
  const expired = await storage.delete("invitation", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  return { verificationExpired, verificationConsumed, invitations: accepted + expired };
}
