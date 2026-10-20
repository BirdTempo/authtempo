import type { ResolvedConfig } from "../config.js";
import { RETIRED_KEY_MS } from "../primitives/jwk.js";
import { type Meter, meterOf } from "../storage/meter.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { deliverDueLogouts } from "./oauth-logout.js";
import { writeLogoutPage } from "./oauth-outbox.js";
import { sweepPendingEnds } from "./operator/access-end.js";
import { SETUP_TTL_MS } from "./totp.js";

export interface SweepResult {
  verificationExpired: number;
  verificationConsumed: number;
  invitations: number;
  /** Session rows past `expiresAt`. */
  sessions: number;
  /**
   * Sessions that a ban or a revoke of the platform role left past its call
   * budget, ended with `session.afterEnd` (ruling 44 of plan 12f).
   */
  pendingSessions: number;
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
  /** Device grants past `expiresAt` (plan 12e, RFC 8628): pending, decided, and spent alike. */
  oauthDevices: number;
  /** Client links whose session is gone, each made an outbox row: at most 250 per sweep (plan 12e), inside the call budget. */
  oauthSessionLinks: number;
  /** Back-channel logouts delivered, or deleted after their last attempt, at most 50 per sweep (plan 12e), inside the call budget. */
  oauthLogouts: number;
  /** Client secrets of a rotation past their overlap, cleared from the client row (plan 12e). */
  oauthClientSecrets: number;
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
// ta_oauth_client forever (spec 8.13 item 7, plan 9g). A client of kind `api`
// stays: an operator made it on purpose through `api.oauth.clients` (plan 12e).
const CLIENT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** One sweep stays short; the next one takes the rest. */
const CLIENT_SWEEP_MAX = 100;

/**
 * The calls of one sweep (ruling 37 of plan 12f). D1 Free allows 50
 * queries per invocation (D1 limits page updated 21 April 2026, read
 * 2026-10-21). Workers Free allows 50 subrequests per invocation (Workers
 * limits page updated 12 October 2026, read 2026-10-21). A subrequest is a
 * fetch or a request to a service such as D1. So the queries
 * and the posts of the outbox share one count of 50. The product runs on
 * Workers Free, so the sweep fits it everywhere; run the sweep more often
 * to send more logouts in an hour.
 */
export const SWEEP_CALL_BUDGET = 50;

/**
 * The calls that the steps before the outbox step leave for it: the read
 * and one row of `deliverDueLogouts` need 10. The rest sends more rows.
 */
export const OUTBOX_SHARE = 16;

/** The calls that the idle client step leaves for the link step: one page needs 5. */
const LINK_SHARE = 8;

/** The most calls of one idle client: the consent read, the token read, and the update or the delete. */
const CLIENT_CALLS = 3;

/**
 * The port has no join, so each idle client costs two reads. The delete
 * repeats the `lastSeenAt` guard: a client that an authorize saw since the
 * read stays. The lookups by client use the consent unique key, which starts
 * with clientId, and the refresh token index on clientId.
 */
async function sweepClients(
  storage: StorageAdapter,
  now: Date,
  meter: Meter,
  limit: number,
): Promise<number> {
  const before = new Date(now.getTime() - CLIENT_IDLE_MS);
  let n = 0;
  if (meter.used + 1 + CLIENT_CALLS > limit) return 0;
  const idle = await storage.findMany(
    "oauthClient",
    [
      { field: "lastSeenAt", op: "lt", value: before },
      { field: "kind", op: "ne", value: "api" },
    ],
    { limit: CLIENT_SWEEP_MAX },
  );
  meter.step(1);
  for (const c of idle) {
    // A client that does not fit waits for the next sweep, with the rest.
    if (meter.used + CLIENT_CALLS > limit) break;
    meter.step(CLIENT_CALLS);
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

/**
 * The client links of one sweep (plan 12e Task 16, rulings 49 and 50). A
 * link whose session is gone means that the session ended. The cause is an
 * expiry, a crash, or a race between a link write and a session end. Each such link
 * gets one `oauthLogout` row in place of a silent delete. The sweep reads
 * the links that it saw longest ago, a page of `LINK_SWEEP_PAGE` at a time,
 * and moves each live link to now. So the reads go round all links.
 *
 * The step stays inside `limit` calls of `meter` (ruling 37 of plan 12f).
 * A page costs the link read, the session read, and the update of the live
 * links. Each link with no session costs 1 more, and one delete removes
 * those links. The rows of a page go in one transaction with their delete.
 * A link that does not fit keeps its time, so the next sweep reads it
 * first. 50 ids and one more term stay under the 100 bound parameters of a
 * D1 query (D1 limits page updated 21 April 2026, read 2026-10-21).
 */
export const LINK_SWEEP_PAGE = 50;
export const LINK_SWEEP_PAGES = 5;

/** The least calls of a page that ends one link: the two reads, the row, the delete, and the update. */
const LINK_PAGE_LEAST = 5;

async function sweepLinks(
  storage: StorageAdapter,
  now: Date,
  meter: Meter,
  limit: number,
): Promise<number> {
  let n = 0;
  for (let page = 0; page < LINK_SWEEP_PAGES; page++) {
    if (meter.used + LINK_PAGE_LEAST > limit) break;
    // Not yet seen in this sweep: a link that a page moved to now is left out.
    const links = await storage.findMany(
      "oauthSessionClient",
      [{ field: "updatedAt", op: "lt", value: now }],
      {
        sort: [
          { field: "updatedAt", dir: "asc" },
          { field: "id", dir: "asc" },
        ],
        limit: LINK_SWEEP_PAGE,
      },
    );
    meter.step(1);
    if (links.length === 0) break;
    const sessionIds = [...new Set(links.map((l) => l.sessionId))];
    const live = new Set(
      (await storage.findMany("session", [{ field: "id", op: "in", value: sessionIds }])).map(
        (s) => s.id,
      ),
    );
    meter.step(1);
    const orphans = links.filter((l) => !live.has(l.sessionId));
    const kept = links.filter((l) => live.has(l.sessionId)).map((l) => l.id);
    // The calls left after the update of the live links and the delete of the page.
    const room = limit - meter.used - (kept.length > 0 ? 1 : 0) - 1;
    const ending = orphans.slice(0, Math.max(0, room));
    if (ending.length > 0) {
      await storage.transaction((tx) => writeLogoutPage(tx, ending, now));
      meter.step(ending.length + 1);
      n += ending.length;
    }
    if (kept.length > 0) {
      await storage.update("oauthSessionClient", [{ field: "id", op: "in", value: kept }], {
        updatedAt: now,
      });
      meter.step(1);
    }
    if (ending.length < orphans.length || links.length < LINK_SWEEP_PAGE) break;
  }
  return n;
}

/**
 * The count of a last step, or 0 with one log line when the storage throws.
 * Each step stays inside its calls, but a storage error can still stop it.
 * The counts above stay, and the next sweep goes on.
 */
async function softStep(name: string, step: Promise<number>): Promise<number> {
  try {
    return await step;
  } catch (e) {
    console.error(
      `authtempo: the sweep ${name} step stopped`,
      e instanceof Error ? e.name : typeof e,
    );
    return 0;
  }
}

/** Deletes rows that no flow can use any more. Call it from a scheduled handler. Safe to run at any time. */
export async function sweepExpired(config: ResolvedConfig): Promise<SweepResult> {
  const { storage } = config;
  const now = config.clock.now();
  // Each step counts its calls, so the whole sweep fits `SWEEP_CALL_BUDGET`.
  const meter = meterOf(storage, 0);
  const graceEnd = new Date(now.getTime() - CONSUMED_GRACE_MS);
  // The port has no OR, so each condition is one statement. The order does
  // not change which rows go. It sets the counts: a row that matches two
  // statements goes in the first, so a consumed and expired verification
  // row counts as expired, and an accepted and expired invitation counts
  // once in `invitations`.
  const verificationExpired = await storage.delete("verification", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  const verificationConsumed = await storage.delete("verification", [
    { field: "consumedAt", op: "lt", value: graceEnd },
  ]);
  meter.step(1);
  const accepted = await storage.delete("invitation", [
    { field: "acceptedAt", op: "ne", value: null },
  ]);
  meter.step(1);
  const expired = await storage.delete("invitation", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  // A session row goes on its own only when someone presents its token
  // after the expiry. A row that nobody presents again keeps its IP address
  // and user agent with no limit (final review M-2, 2026-10-10).
  const expiredSessions: Where<"session">[] = [{ field: "expiresAt", op: "lt", value: now }];
  // The row locks first, by id, in a transaction, as every multi-row
  // session delete takes them (rulings 36 and 37 of plan 12f). One DELETE
  // locks rows in the order of its scan, so it and endAll can wait on each
  // other. An adapter with no row lock deletes in one statement.
  const sessions = storage.lockInOrder
    ? await storage.transaction(async (tx) => {
        await tx.lockInOrder?.("session", expiredSessions);
        return tx.delete("session", expiredSessions);
      })
    : await storage.delete("session", expiredSessions);
  meter.step(storage.lockInOrder ? 2 : 1);
  // An expired token goes on its own only when a script presents it again.
  // A null expiry never matches lt (port.ts null rules), so it stays.
  // A row at exactly `expiresAt` is refused by `resolveApiToken` (`<=`) and goes at the next sweep.
  const apiTokens = await storage.delete("apiToken", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  // No flow deletes an expired trusted device: each trust read refuses it
  // (`liveTrust`), and only this sweep deletes it.
  const trustedDevices = await storage.delete("trustedDevice", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  // A retired key verifies for 24 hours; after that no token it signed may pass.
  const jwks = await storage.delete("jwk", [
    { field: "retiredAt", op: "lt", value: new Date(now.getTime() - RETIRED_KEY_MS) },
  ]);
  meter.step(1);
  const oauthTokens = await storage.delete("oauthToken", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  // The check of a client secret refuses an old secret past its time
  // (`secretMatches`). This clear keeps no dead hash in the row.
  const oauthClientSecrets = await storage.update(
    "oauthClient",
    [{ field: "previousSecretUntil", op: "lt", value: now }],
    { previousSecretHash: null, previousSecretUntil: null, updatedAt: now },
  );
  meter.step(1);
  // A poll of an expired device row answers expired_token. After the
  // expiry the row holds hashes that no flow reads, so it goes.
  const oauthDevices = await storage.delete("oauthDevice", [
    { field: "expiresAt", op: "lt", value: now },
  ]);
  meter.step(1);
  // A setup that no enable confirmed stays until the user's next setup.
  // After 15 minutes the enable refuses it, so it holds a sealed secret that
  // no flow uses. `createdAt` is the setup time: a new setup rewrites it.
  const totpSetups = await storage.delete("totp", [
    { field: "enabledAt", op: "eq", value: null },
    { field: "createdAt", op: "lt", value: new Date(now.getTime() - SETUP_TTL_MS) },
  ]);
  meter.step(1);
  // The owned limiters keep one row per key and window. Without this sweep
  // every address and IP that reached a limiter stays in ta_limit forever.
  // A limiter on the database sends its delete outside the storage counter.
  if (config.limiter.sweep) meter.add(1);
  const limits = (await config.limiter.sweep?.(now)) ?? 0;
  // After the refresh tokens, so a client whose last token just expired can go.
  // After the four single-statement steps too: the client step may use the
  // calls up to its limit, and the link step must still get `LINK_SHARE`.
  // A page of links needs 5 calls (review m1 of the 12f Task 7 fix 2).
  const oauthClients = await sweepClients(
    storage,
    now,
    meter,
    SWEEP_CALL_BUDGET - LINK_SHARE - OUTBOX_SHARE,
  );
  // Last, so a storage limit met here leaves every count above done. The
  // links of the sessions that ended become outbox rows, and the outbox
  // sends its due rows (plan 12e Task 16).
  const oauthSessionLinks = await softStep(
    "link",
    sweepLinks(storage, now, meter, SWEEP_CALL_BUDGET - OUTBOX_SHARE),
  );
  const oauthLogouts = await softStep(
    "outbox",
    deliverDueLogouts(config, meter, SWEEP_CALL_BUDGET),
  );
  // Last, in the calls that stay. Every door already refuses such a
  // session: `bannedFor` for a ban, and the live role read of each operator
  // check for a revoke. So a logout, which reaches another party, comes
  // first. The step reads nothing when its least work does not fit.
  const pendingSessions = await softStep(
    "pending end",
    sweepPendingEnds(config, meter, SWEEP_CALL_BUDGET),
  );
  return {
    verificationExpired,
    verificationConsumed,
    invitations: accepted + expired,
    sessions,
    pendingSessions,
    apiTokens,
    trustedDevices,
    jwks,
    oauthTokens,
    oauthClients,
    totpSetups,
    limits,
    oauthDevices,
    oauthSessionLinks,
    oauthLogouts,
    oauthClientSecrets,
  };
}
