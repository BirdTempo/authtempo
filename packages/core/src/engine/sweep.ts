import type { ResolvedConfig } from "../config.js";
import { RETIRED_KEY_MS } from "../primitives/jwk.js";
import type { StorageAdapter } from "../storage/port.js";
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
  /** Retired signing keys past their 24 hours of verification (plan 9g). */
  jwks: number;
  /** Refresh tokens past `expiresAt` (plan 9g). A used row stays until then: it detects a reuse. */
  oauthTokens: number;
  /** OAuth clients unseen for 90 days with no consent and no refresh token, at most 100 per sweep (plan 9g). */
  oauthClients: number;
  /** Unconfirmed TOTP setups older than 15 minutes, which no enable can confirm (plan 9f final fix wave). */
  totpSetups: number;
  /** Limiter windows that ended. 0 when the limiter has no sweep. */
  limits: number;
  /** Device grants past `expiresAt` (plan 12e, RFC 8628). Always 0 until the device grant of plan 12e Task 14. */
  oauthDevices: number;
  /** Session links to clients whose session is gone (plan 12e). Always 0 until plan 12e Task 16. */
  oauthSessionLinks: number;
  /** Back-channel logouts delivered or given up (plan 12e). Always 0 until plan 12e Task 16. */
  oauthLogouts: number;
}

// The first delete removes every verification row past `expiresAt`,
// consumed or not. Every default ttl is 15 minutes or less, so a consumed
// row goes at the first sweep after its expiry. The second delete only
// matters when an app sets `magicLink.ttlMinutes` above one day: it then
// removes a consumed row one day after the consume. A replayed token
// answers `invalid_token` because the row is gone, not because it stays.
const CONSUMED_GRACE_MS = 24 * 60 * 60 * 1000;

// A client that no authorize and no metadata fetch saw for 90 days, and
// that holds no consent and no refresh token, has nothing a user could lose:
// no grant names it. Without this sweep every dynamic registration stays in
// ta_oauth_client forever (spec 8.13 item 7, plan 9g).
const CLIENT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** One sweep stays short; the next one takes the rest. */
const CLIENT_SWEEP_MAX = 100;

/**
 * The port has no join, so each idle client costs two reads. The delete
 * repeats the `lastSeenAt` guard: a client that an authorize saw since the
 * read stays. The lookups by client use the consent unique key, which starts
 * with clientId, and the refresh token index on clientId.
 */
async function sweepClients(storage: StorageAdapter, now: Date): Promise<number> {
  const before = new Date(now.getTime() - CLIENT_IDLE_MS);
  let n = 0;
  const idle = await storage.findMany(
    "oauthClient",
    [{ field: "lastSeenAt", op: "lt", value: before }],
    { limit: CLIENT_SWEEP_MAX },
  );
  for (const c of idle) {
    const kept =
      (await storage.findOne("oauthConsent", [{ field: "clientId", op: "eq", value: c.id }])) ??
      (await storage.findOne("oauthToken", [{ field: "clientId", op: "eq", value: c.id }]));
    if (kept) {
      // A kept client counts as seen by the sweep. The move takes it out of
      // the idle set for 90 days, so the next read reaches other clients:
      // without it, 100 kept clients fill every read and no client goes.
      // The guard on the read value keeps a newer time that an authorize wrote.
      await storage.update(
        "oauthClient",
        [
          { field: "id", op: "eq", value: c.id },
          { field: "lastSeenAt", op: "eq", value: c.lastSeenAt },
        ],
        { lastSeenAt: now },
      );
      continue;
    }
    n += await storage.delete("oauthClient", [
      { field: "id", op: "eq", value: c.id },
      { field: "lastSeenAt", op: "lt", value: before },
    ]);
  }
  return n;
}

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
  // No flow deletes an expired trusted device: each trust read refuses it
  // (`liveTrust`), and only this sweep deletes it.
  const trustedDevices = await storage.delete("trustedDevice", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  // A retired key verifies for 24 hours; after that no token it signed may pass.
  const jwks = await storage.delete("jwk", [
    { field: "retiredAt", op: "lt", value: new Date(now.getTime() - RETIRED_KEY_MS) },
  ]);
  const oauthTokens = await storage.delete("oauthToken", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  // After the refresh tokens, so a client whose last token just expired can go.
  const oauthClients = await sweepClients(storage, now);
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
    jwks,
    oauthTokens,
    oauthClients,
    totpSetups,
    limits,
    // Plan 12e Tasks 14 and 16 write these deletes.
    oauthDevices: 0,
    oauthSessionLinks: 0,
    oauthLogouts: 0,
  };
}
