import type { Pool, PoolConnection } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

// MySQL has no DELETE … RETURNING, so `deleteRows` reads the rows under their
// locks and then deletes them by id (plan 12o). A call outside a transaction
// opens one, so the locks hold until the delete. A rival delete between the
// locking read and the delete then waits, and removes nothing. Without that
// transaction each statement ends its own locks. Then the rival removes a row,
// and the call answers a row that it did not remove (L3 of the Task 3 review).

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

type Execute = (sql: string, params?: unknown) => Promise<unknown>;

/** `pool`, with `after` run after each statement that a connection or the pool executes. */
function watched(pool: Pool, after: (sql: string) => Promise<void>): Pool {
  const execute =
    (target: { execute: Execute }): Execute =>
    async (sql, params) => {
      const answer = await target.execute(sql, params);
      await after(sql);
      return answer;
    };
  const bound = <T extends object>(target: T, key: string | symbol) => {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(pool, {
    get(target, key) {
      if (key === "execute") return execute(target as unknown as { execute: Execute });
      if (key === "getConnection")
        return async () => {
          const conn = await target.getConnection();
          return new Proxy(conn, {
            get(c: PoolConnection, k) {
              if (k === "execute") return execute(c as unknown as { execute: Execute });
              return bound(c, k);
            },
          });
        };
      return bound(target, key);
    },
  });
}

for (const server of MYSQL_SERVERS)
  describe(`deleteRows outside a transaction on MySQL ${server.version} (L3 of the 12o Task 3 review)`, () => {
    it("holds the locks of its read until its delete, so a rival delete between the two waits and removes nothing", async () => {
      db = await freshDatabase(server);
      const plain = createMysqlAdapter(db.pool);
      for (const id of ["s1", "s2", "s3"])
        await plain.create("session", rowOf("session", { id, userId: "u-dr" }));
      const byUser = [{ field: "userId" as const, op: "eq" as const, value: "u-dr" }];
      const race: { rival: Promise<number> | null } = { rival: null };
      const mine = createMysqlAdapter(
        watched(db.pool, async (sql) => {
          if (race.rival || !sql.endsWith(" FOR UPDATE")) return;
          // The rival deletes s2 after the locking read, on another connection, outside a transaction.
          race.rival = plain.delete("session", [{ field: "id", op: "eq", value: "s2" }]);
          // It waits for the lock of s2, so the call goes on after 300 ms.
          await Promise.race([race.rival, new Promise((r) => setTimeout(r, 300))]);
        }),
      );
      const answered = await mine.deleteRows("session", byUser);
      expect(race.rival).not.toBeNull();
      // The rival ran after the call's commit, so it found no row.
      expect(await race.rival).toBe(0);
      expect(answered.map((r) => r.id).sort()).toEqual(["s1", "s2", "s3"]);
      expect(await plain.findMany("session", byUser)).toEqual([]);
    });
  });
