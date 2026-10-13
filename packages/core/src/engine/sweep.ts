import type { ResolvedConfig } from "../config.js";
import { SETUP_TTL_MS } from "./totp.js";

export interface SweepResult {
  verificationExpired: number;
  verificationConsumed: number;
  invitations: number;
  /** Session rows past `expiresAt`. */
  sessions: number;
  /** API token rows past `expiresAt`. A token with no expiry is never swept. */
  apiTokens: number;
  /** Trusted device rows past `expiresAt` (plan 9f). */
  trustedDevices: number;
  /** Unconfirmed TOTP setups older than 15 minutes, which no enable can confirm (plan 9f final fix wave). */
  totpSetups: number;
  /** Limiter windows that ended. 0 when the limiter has no sweep. */
  limits: number;
}

// The first delete removes every verification row past `expiresAt`,
// consumed or not. Every default ttl is 15 minutes or less, so a consumed
// row goes at the first sweep after its expiry. The second delete only
// matters when an app sets `magicLink.ttlMinutes` above one day: it then
// removes a consumed row one day after the consume. A replayed token
// answers `invalid_token` because the row is gone, not because it stays.
const CONSUMED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Deletes rows that no flow can use any more. Call it from a scheduled handler. Safe to run at any time. */
export async function sweepExpired(config: ResolvedConfig): Promise<SweepResult> {
  const { storage } = config;
  const now = config.clock.now();
  const graceEnd = new Date(now.getTime() - CONSUMED_GRACE_MS);
  // The port has no OR, so each condition is one statement. The order does
  // not change which rows go. It sets the counts: a row that matches two
  // statements goes in the first, so a consumed and expired verification
  // row counts as expired, and an accepted and expired invitation counts
  // once in `invitations`.
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
  // A session row goes on its own only when someone presents its token
  // after the expiry. A row that nobody presents again keeps its IP address
  // and user agent with no limit (final review M-2, 2026-10-10).
  const sessions = await storage.delete("session", [{ field: "expiresAt", op: "lt", value: now }]);
  // An expired token goes on its own only when a script presents it again.
  // A null expiry never matches lt (port.ts null rules), so it stays.
  // A row at exactly `expiresAt` is refused by `resolveApiToken` (`<=`) and goes at the next sweep.
  const apiTokens = await storage.delete("apiToken", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  // A trusted device goes on its own only when a sign-in presents its token
  // after the expiry. A device that never signs in again stays without this.
  const trustedDevices = await storage.delete("trustedDevice", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  // A setup that no enable confirmed stays until the user's next setup.
  // After 15 minutes the enable refuses it, so it holds a sealed secret that
  // no flow uses. `createdAt` is the setup time: a new setup rewrites it.
  const totpSetups = await storage.delete("totp", [
    { field: "enabledAt", op: "eq", value: null },
    { field: "createdAt", op: "lt", value: new Date(now.getTime() - SETUP_TTL_MS) },
  ]);
  // The owned limiters keep one row per key and window. Without this sweep
  // every address and IP that reached a limiter stays in ta_limit forever.
  const limits = (await config.limiter.sweep?.(now)) ?? 0;
  return {
    verificationExpired,
    verificationConsumed,
    invitations: accepted + expired,
    sessions,
    apiTokens,
    trustedDevices,
    totpSetups,
    limits,
  };
}
