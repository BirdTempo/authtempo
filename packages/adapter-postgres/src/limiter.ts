import { type Clock, type LimiterPort, limiterKey, systemClock } from "@authtempo/core";
import type { Sql } from "postgres";

/**
 * One statement: insert the key at count 1, or on conflict reset the window
 * when it has ended, else add 1. The upsert takes the row lock, so two
 * concurrent calls at `max - 1` cannot both read `max - 1`: one sees `max`,
 * the other `max + 1`. `$1` the stored key, `$2` now in ms, `$3` the window in ms.
 * Both are bigint, so the statement compares integers, as on D1.
 */
const ALLOW = `INSERT INTO ta_limit (key, window_start, count, expires_at) VALUES ($1, $2::bigint, 1, $2::bigint + $3::bigint)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN ta_limit.window_start + $3::bigint <= $2::bigint THEN 1 ELSE ta_limit.count + 1 END,
  window_start = CASE WHEN ta_limit.window_start + $3::bigint <= $2::bigint THEN $2::bigint ELSE ta_limit.window_start END,
  expires_at = CASE WHEN ta_limit.window_start + $3::bigint <= $2::bigint THEN $2::bigint + $3::bigint ELSE ta_limit.window_start + $3::bigint END
RETURNING count`;

/** A window that ended. `expires_at` is the window start plus the window. */
const SWEEP = "DELETE FROM ta_limit WHERE expires_at <= $1::bigint";

/**
 * The limiter the product owns on Postgres: one count per key and window for
 * every replica and isolate, kept in `ta_limit` (schema version 3). The
 * memory limiter counts per isolate, so its real limit is its limit times
 * the isolate count.
 */
export function createPostgresLimiter(sql: Sql, clock: Clock = systemClock): LimiterPort {
  return {
    async allow(key, window) {
      const id = limiterKey(key, window);
      const rows = await sql.unsafe<{ count: string | number }[]>(ALLOW, [
        id,
        clock.now().getTime(),
        window.seconds * 1000,
      ]);
      const row = rows[0];
      if (row === undefined) throw new Error("authtempo limiter: the upsert returned no row");
      // postgres.js answers a bigint as a string.
      return Number(row.count) <= window.max;
    },
    async sweep(now) {
      const res = await sql.unsafe(SWEEP, [now.getTime()]);
      return res.count;
    },
  };
}
