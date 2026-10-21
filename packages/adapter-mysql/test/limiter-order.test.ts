import { limiterKey } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createMysqlLimiter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

for (const server of MYSQL_SERVERS) {
  describe(`the MySQL limiter statement on ${server.version}`, () => {
    it("resets the window at its boundary", async () => {
      db = await freshDatabase(server);
      const t = new Date("2026-01-01T00:00:00.000Z").getTime();
      let now = t;
      const limiter = createMysqlLimiter(db.pool, { now: () => new Date(now) });
      const w = { seconds: 60, max: 5 };
      const ms = w.seconds * 1000;
      const read = async () => {
        const rows = await (db as MysqlDatabase).q<
          { window_start: number; count: number; expires_at: number }[]
        >`SELECT window_start, count, expires_at FROM ta_limit WHERE ${(db as MysqlDatabase).q("key")} = ${limiterKey("k", w)}`;
        return rows.map((r) => [Number(r.window_start), Number(r.count), Number(r.expires_at)]);
      };
      await limiter.allow("k", w);
      expect(await read()).toEqual([[t, 1, t + ms]]);
      now = t + ms - 1;
      await limiter.allow("k", w);
      expect(await read()).toEqual([[t, 2, t + ms]]);
      now = t + ms;
      await limiter.allow("k", w);
      expect(await read()).toEqual([[t + ms, 1, t + 2 * ms]]);
    });
  });
}
