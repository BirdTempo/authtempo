import { type Clock, type LimiterPort, limiterKey, systemClock } from "@tempo-auth/core";

/**
 * One statement: insert the key at count 1, or on conflict reset the window
 * when it has ended, else add 1. D1 runs one statement at a time, so two
 * concurrent calls at `max - 1` cannot both read `max - 1`: one sees `max`,
 * the other `max + 1`. `?1` the stored key, `?2` now in ms, `?3` the window in ms.
 */
const ALLOW = `INSERT INTO ta_limit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ta_limit.window_start + ?3 <= ?2 THEN 1 ELSE ta_limit.count + 1 END,
  window_start = CASE WHEN ta_limit.window_start + ?3 <= ?2 THEN ?2 ELSE ta_limit.window_start END
RETURNING count`;

/**
 * The limiter the product owns on D1: one count per key and window for every
 * isolate, kept in `ta_limit` (schema version 3). The memory limiter counts
 * per isolate, so its real limit is its limit times the isolate count.
 */
export function createD1Limiter(db: D1Database, clock: Clock = systemClock): LimiterPort {
  return {
    async allow(key, window) {
      const id = limiterKey(key, window);
      const row = await db
        .prepare(ALLOW)
        .bind(id, clock.now().getTime(), window.seconds * 1000)
        .first<{ count: number }>();
      if (row === null) throw new Error("tempo-auth limiter: the upsert returned no row");
      return Number(row.count) <= window.max;
    },
  };
}
