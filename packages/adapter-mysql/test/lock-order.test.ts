import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

// Ruling 2 of plan 12g. InnoDB locks each index record as it scans, in the
// order of the index that it reads, before ORDER BY. So a lock by user id
// in one FOR UPDATE takes the rows in (user_id, id) order. A caller that
// locks by id can then deadlock with it. lockInOrder reads the ids and then locks
// them on PRIMARY.

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

for (const server of MYSQL_SERVERS) {
  describe(`lockInOrder on MySQL ${server.version}`, () => {
    it("locks by id when the index order differs", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool);
      // s1 belongs to user b and s2 to user a: id order and user order differ.
      await adapter.create("session", rowOf("session", { id: "s1", userId: "b" }));
      await adapter.create("session", rowOf("session", { id: "s2", userId: "a" }));
      // Many sessions of other users, so the server reads the user_id index
      // for two users and not the whole table.
      for (let i = 0; i < 200; i++)
        await adapter.create("session", rowOf("session", { id: `t${i}`, userId: `c${i % 20}` }));
      // InnoDB counts the rows of a table in the background. ANALYZE makes the
      // count now, so the server reads the user_id index, as on a live table.
      await db.pool.query("ANALYZE TABLE ta_session");
      const order: string[] = [];
      let first: () => void = () => {};
      const holdsFirst = new Promise<void>((r) => {
        first = r;
      });
      // A locks s1 and then s2, in id order.
      const a = adapter.transaction(async (tx) => {
        await tx.update("session", [{ field: "id", op: "eq", value: "s1" }], { ip: "1" });
        first();
        await new Promise((r) => setTimeout(r, 300));
        await tx.update("session", [{ field: "id", op: "eq", value: "s2" }], { ip: "2" });
        order.push("a");
      });
      await holdsFirst;
      // B by user: in id order it waits on s1 and holds nothing. In index
      // order it holds s2 and waits on s1, while A waits on s2: a deadlock.
      const b = adapter.transaction(async (tx) => {
        await tx.lockInOrder?.("session", [{ field: "userId", op: "in", value: ["a", "b"] }]);
        order.push("b");
      });
      await Promise.all([a, b]);
      expect(order).toEqual(["a", "b"]);
    });
  });
}
