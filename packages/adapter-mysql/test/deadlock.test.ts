import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

// InnoDB locks each row that a statement scans. A DELETE outside a
// transaction can meet the locks of a transaction in another order, and
// InnoDB ends the lighter one with 1213. The account delete met it beside a
// reset (account-races.test.ts, 2026-10-21). The adapter sends such a
// statement again.

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

for (const server of MYSQL_SERVERS) {
  describe(`a deadlock on MySQL ${server.version}`, () => {
    it("sends a statement outside a transaction again when InnoDB ends it in a deadlock", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool);
      await adapter.create("session", rowOf("session", { id: "r1", ip: "x" }));
      await adapter.create("session", rowOf("session", { id: "r2", ip: "x" }));
      // Rows after r2 in id order, which the transaction writes first: it is
      // then the heavier one, so InnoDB ends the DELETE.
      for (let i = 0; i < 40; i++)
        await adapter.create("session", rowOf("session", { id: `z${i}`, ip: "y" }));
      let holds: () => void = () => {};
      const held = new Promise<void>((r) => {
        holds = r;
      });
      const order: string[] = [];
      const tx = adapter.transaction(async (t) => {
        await t.update("session", [{ field: "ip", op: "eq", value: "y" }], { userAgent: "w" });
        await t.update("session", [{ field: "id", op: "eq", value: "r2" }], { userAgent: "a" });
        holds();
        await new Promise((r) => setTimeout(r, 300));
        // The DELETE holds r1 and waits on r2: this lock closes the cycle.
        await t.update("session", [{ field: "id", op: "eq", value: "r1" }], { userAgent: "b" });
        order.push("transaction");
      });
      await held;
      // No index on ip: the DELETE scans by id, so it locks r1 and then waits on r2.
      const deleted = adapter
        .delete("session", [{ field: "ip", op: "eq", value: "x" }])
        .then((n) => {
          order.push("delete");
          return n;
        });
      await tx;
      expect(await deleted).toBe(2);
      expect(order).toEqual(["transaction", "delete"]);
      expect(
        (await adapter.findMany("session", [{ field: "ip", op: "eq", value: "x" }])).length,
      ).toBe(0);
    });
  });
}
