import type { ResolvedConfig } from "../config.js";
import { limit } from "../limiter/limit.js";
import type { LimitWindow } from "../limiter/port.js";
import { fail, ok, type Result } from "../result.js";
import type { ApiTokenRow } from "../schema.js";

/**
 * The per-token window and the quota of an API token (plan 12k, spec 29
 * items 12 and 13). Both are limits that the product sells, so core's own
 * limiter and core's own storage enforce them, never a supplier.
 */

/** The bounds of a window: 1 second to 1 day, and 1 to 100000 calls. */
export const WINDOW_SECONDS_MAX = 86_400;
export const WINDOW_CALLS_MAX = 100_000;
/** The largest count: the Postgres column is `integer` (ruling 9 of plan 12k). */
export const COUNT_MAX = 2_147_483_647;
/**
 * The most tries of one spend. A try loses only when another call wrote the
 * count first, and each call writes it once. So in a burst of k calls, each
 * call needs at most k tries, and 20 tries let a burst of 20 calls all spend.
 * That is twice the default pool of 10 connections of postgres.js. On D1 the
 * worst spend is 40 statements, 20 updates and 20 reads. With the 5 other
 * statements of a token resolve, one call makes 45 at most. That is under the
 * 50 queries of one Workers Free invocation (D1 limits page updated
 * 2026-04-21, read 2026-10-20).
 */
const SPEND_TRIES = 20;

/** A usage quota: `remaining` calls, and an optional refill that sets the count to `refillAmount`. */
export interface TokenQuota {
  remaining: number;
  refillAmount?: number;
  refillSeconds?: number;
}

/** The fields of a token row that the window and the quota read. */
export type UseRow = Pick<
  ApiTokenRow,
  | "id"
  | "rateLimitSeconds"
  | "rateLimitMax"
  | "remaining"
  | "refillAmount"
  | "refillSeconds"
  | "lastRefillAt"
  | "createdAt"
>;

function inRange(n: unknown, min: number, max: number): boolean {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
}

/** True for a window of whole seconds from 1 to 86400 and whole calls from 1 to 100000. */
export function validWindow(w: LimitWindow): boolean {
  return inRange(w.seconds, 1, WINDOW_SECONDS_MAX) && inRange(w.max, 1, WINDOW_CALLS_MAX);
}

/** True for a quota with `remaining` from 0, and both refill fields or neither. */
export function validQuota(q: TokenQuota): boolean {
  if (!inRange(q.remaining, 0, COUNT_MAX)) return false;
  if (q.refillAmount === undefined && q.refillSeconds === undefined) return true;
  return inRange(q.refillAmount, 0, COUNT_MAX) && inRange(q.refillSeconds, 1, COUNT_MAX);
}

/** The window of a row, or null for a token with none. */
export function windowOf(
  row: Pick<UseRow, "rateLimitSeconds" | "rateLimitMax">,
): LimitWindow | null {
  return row.rateLimitSeconds === null || row.rateLimitMax === null
    ? null
    : { seconds: row.rateLimitSeconds, max: row.rateLimitMax };
}

/**
 * True when the call fits the token's window, or the token has none. One
 * limiter call and no storage call. The limiter keeps `seconds` and `max` in
 * its stored key, so a change of the window starts a new count.
 */
export function useWindow(
  config: ResolvedConfig,
  kind: "tk" | "to",
  row: UseRow,
): Promise<boolean> {
  const window = windowOf(row);
  if (window === null) return Promise.resolve(true);
  // The limiter key is `token-use:tk:<id>` or `token-use:to:<id>`.
  return limit(config, kind === "tk" ? "token-use:tk" : "token-use:to", row.id, window);
}

/**
 * Spends one call of the quota of `row`, the row as the caller read it. It
 * answers the count after the spend, or null for a token with no quota (no
 * storage call). A due refill sets the count to `refillAmount` and spends one
 * of it. A next count below zero answers `token_exhausted` with no write.
 *
 * Each try is one `update` with `where` on `id`, `remaining`, and
 * `lastRefillAt` as read. That is one statement, so SQLite runs it alone and
 * Postgres locks the row for it. Zero rows means that the row changed: read it
 * again. When the count or the refill time moved, another call spent, so try
 * again with the new row. When neither moved, answer `conflict`. After
 * `SPEND_TRIES` lost tries, answer `conflict` too.
 *
 * Storage calls: one update per try, and one findOne per lost try. So a spend
 * is 1 statement when no other call spends, and 40 at most. A row that is gone
 * answers `unauthorized`. It writes in every read mode: the quota is a sold
 * limit.
 */
export async function spendUse(
  config: ResolvedConfig,
  model: "apiToken" | "organizationToken",
  row: UseRow,
): Promise<Result<number | null>> {
  let current = row;
  for (let tries = 0; tries < SPEND_TRIES; tries++) {
    if (current.remaining === null) return ok(null);
    const now = config.clock.now();
    const from = current.lastRefillAt ?? current.createdAt;
    const due =
      current.refillAmount !== null &&
      current.refillSeconds !== null &&
      now.getTime() >= from.getTime() + current.refillSeconds * 1000;
    const next = due ? (current.refillAmount ?? 0) - 1 : current.remaining - 1;
    if (next < 0) return fail("token_exhausted");
    const n = await config.storage.update(
      model,
      [
        { field: "id", op: "eq", value: current.id },
        { field: "remaining", op: "eq", value: current.remaining },
        { field: "lastRefillAt", op: "eq", value: current.lastRefillAt },
      ],
      due ? { remaining: next, lastRefillAt: now } : { remaining: next },
    );
    if (n === 1) return ok(next);
    const again = await config.storage.findOne(model, [
      { field: "id", op: "eq", value: current.id },
    ]);
    if (!again) return fail("unauthorized");
    // A loss with no change of the count is no rival spend, so a new try would lose again.
    if (again.remaining === current.remaining && sameTime(again.lastRefillAt, current.lastRefillAt))
      return fail("conflict");
    current = again;
  }
  return fail("conflict");
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}
