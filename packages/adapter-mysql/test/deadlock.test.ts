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

    it("passes a deadlock inside a transaction through, and the transaction leaves no write", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool);
      await adapter.create("session", rowOf("session", { id: "r1" }));
      await adapter.create("session", rowOf("session", { id: "r2" }));
      let aHolds: () => void = () => {};
      let bHolds: () => void = () => {};
      const aHeld = new Promise<void>((r) => {
        aHolds = r;
      });
      const bHeld = new Promise<void>((r) => {
        bHolds = r;
      });
      // A locks r1, then r2. B locks r2, then r1: a cycle that InnoDB ends in one of them.
      const run = (first: string, second: string, holds: () => void, other: Promise<void>) =>
        adapter.transaction(async (t) => {
          await t.update("session", [{ field: "id", op: "eq", value: first }], {
            userAgent: first,
          });
          holds();
          await other;
          await t.update("session", [{ field: "id", op: "eq", value: second }], {
            userAgent: first,
          });
          return first;
        });
      const results = await Promise.allSettled([
        run("r1", "r2", aHolds, bHeld),
        run("r2", "r1", bHolds, aHeld),
      ]);
      const failed = results.filter((r) => r.status === "rejected");
      const passed = results.filter((r) => r.status === "fulfilled");
      // A statement sent again inside the undone transaction would let both end.
      expect(failed.map((r) => (r.reason as { errno?: number }).errno)).toEqual([1213]);
      expect(passed).toHaveLength(1);
      const winner = (passed[0] as PromiseFulfilledResult<string>).value;
      const rows = await adapter.findMany("session", [], { sort: { field: "id", dir: "asc" } });
      // Both rows hold the winner's write; the victim's first write was undone.
      expect(rows.map((r) => r.userAgent)).toEqual([winner, winner]);
    });
  });
}
