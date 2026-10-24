import { type Clock, type LimiterPort, limiterKey, systemClock } from "@authtempo/core";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

/**
 * Insert the key at count 1, or on a duplicate key reset the window when it
 * has ended, else add 1. MySQL has no RETURNING. MySQL applies the
 * assignments of one UPDATE from left to right. A later one reads the new
 * value of an earlier one, so count and expires_at read window_start before
 * it moves. The parameters are the stored key, then now and the window in
 * ms in the order of the placeholders (`params`).
 */
const ALLOW = `INSERT INTO \`ta_limit\` (\`key\`, \`window_start\`, \`count\`, \`expires_at\`) VALUES (?, ?, 1, ? + ?)
ON DUPLICATE KEY UPDATE
  \`count\` = IF(\`window_start\` + ? <= ?, 1, \`count\` + 1),
  \`expires_at\` = IF(\`window_start\` + ? <= ?, ? + ?, \`window_start\` + ?),
  \`window_start\` = IF(\`window_start\` + ? <= ?, ?, \`window_start\`)`;

/** The parameters of ALLOW in placeholder order. */
function params(key: string, now: number, ms: number): (string | number)[] {
  return [key, now, now, ms, ms, now, ms, now, now, ms, ms, ms, now, now];
}

const COUNT = "SELECT `count` FROM `ta_limit` WHERE `key` = ?";

/** A window that ended. `expires_at` is the window start plus the window. */
const SWEEP = "DELETE FROM `ta_limit` WHERE `expires_at` <= ?";

/**
 * The limiter the product owns on MySQL: one count per key and window for
 * every replica, kept in `ta_limit`. The upsert and the read of the count
 * run in one transaction on one connection. The upsert holds the row lock
 * until the commit, so the read sees this call's count and no other.
 */
export function createMysqlLimiter(pool: Pool, clock: Clock = systemClock): LimiterPort {
  return {
    // The count lives in the database, so every isolate of the deployment reads one count.
    scope: "shared",
    async allow(key, window) {
      const id = limiterKey(key, window);
      const conn = await pool.getConnection();
      let broken = false;
      try {
        await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await conn.query("START TRANSACTION");
        try {
          await conn.execute<ResultSetHeader>(
            ALLOW,
            params(id, clock.now().getTime(), window.seconds * 1000),
          );
          const [rows] = await conn.execute<RowDataPacket[]>(COUNT, [id]);
          await conn.query("COMMIT");
          const row = rows[0];
          if (row === undefined) throw new Error("authtempo limiter: the upsert left no row");
          return Number(row.count) <= window.max;
        } catch (e) {
          try {
            await conn.query("ROLLBACK");
          } catch {
            broken = true;
          }
          throw e;
        }
      } finally {
        if (broken) conn.destroy();
        else conn.release();
      }
    },
    async sweep(now) {
      const [res] = await pool.execute<ResultSetHeader>(SWEEP, [now.getTime()]);
      return res.affectedRows;
    },
  };
}
