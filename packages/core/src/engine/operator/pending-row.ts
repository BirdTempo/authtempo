import type { Clock } from "../../primitives/clock.js";
import { sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import type { StorageAdapter } from "../../storage/port.js";

// The row of a pending end, apart from the act that writes it (plan 12q).
// The claim writes it too, and the claim's module must not import the
// operator acts: their imports reach the claim's module. So the row and its
// two bounds live here, with no import of an engine flow.

/**
 * The life of a pending-end row: 3650 days, far past the life of any
 * session. The sweep ends its work first, so the row never expires before
 * that. The first sweep step deletes the expired verification rows, so a
 * short life could drop a row with work left.
 */
export const PENDING_END_MS = 3650 * 86_400_000;

/**
 * The skew bound of `before` (ruling 58 of plan 12d): `before` is at least
 * the clock of the act plus 5 s. Another instance can write a session or a
 * family with a clock that runs ahead, also after the act read its rows.
 * On Workers, `Date.now()` returns the time of the last I/O, and it does
 * not advance while code runs (Cloudflare docs, Workers security model,
 * read 2026-10-24). So the clock of a request can lag, and does not run
 * ahead inside the request. That page says nothing of the skew between
 * hosts: 5 s is a margin that core chooses, not a fact of the page. The
 * cost: a session or a family that
 * starts in the 5 s after the act is refused too, as one from before it.
 * A longer bound refuses more such sign-ins, so the bound stays short.
 */
export const ACCESS_END_SKEW_MS = 5_000;

/**
 * Writes one pending-end row of `userId` in the act's transaction: a
 * verification row with the purpose `session-end`. `data.before` is the
 * later of `now` plus `ACCESS_END_SKEW_MS` and one ms past `newest`, the
 * newest `createdAt` that the act read (rulings 55 and 58 of plan 12d). An
 * act that read no row passes `-Infinity`. `data` holds the names of the
 * row after `reason` and `before`. The answer is `data.before`.
 */
export async function createPendingEnd(
  tx: StorageAdapter,
  now: Date,
  userId: string,
  reason: string,
  newest: number,
  data: Record<string, unknown>,
  secretVersion: number,
): Promise<Date> {
  const bound = now.getTime() + ACCESS_END_SKEW_MS;
  const before = new Date(Number.isFinite(newest) ? Math.max(bound, newest + 1) : bound);
  const id = newId(now);
  await tx.create("verification", {
    id,
    purpose: "session-end",
    identifier: userId,
    // No code: the hash of the id fills the unique key.
    valueHash: await sha256Hex(`session-end:${id}`),
    expiresAt: new Date(now.getTime() + PENDING_END_MS),
    consumedAt: null,
    data: { reason, before: before.toISOString(), ...data },
    secretVersion,
    createdAt: now,
    updatedAt: now,
  });
  return before;
}

/**
 * The pending-end row of a claim (decision 3 of plan 12q): the reason
 * `claimed`, no target, no family. The claim calls it when its sessions
 * pass its two chunks. The sweep then ends the rest, and only the sessions
 * whose `proved` flag is false (`endPendingRows`). A session of the owner
 * after the claim is proved, so the row never ends it. The time is a fresh
 * read of `clock`, as for the lease. The row holds no code, so its secret
 * version is 1, as for the lease row.
 */
export function writeClaimEnd(
  tx: StorageAdapter,
  clock: Clock,
  userId: string,
  newest: number,
): Promise<Date> {
  return createPendingEnd(tx, clock.now(), userId, "claimed", newest, {}, 1);
}
