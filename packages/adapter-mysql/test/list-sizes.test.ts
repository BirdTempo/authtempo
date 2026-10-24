import type { RowDataPacket } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";

// MySQL keeps one server prepared statement per SQL text on each connection (ruling 85 of
// plan 12d, MA-3). The server holds at most 16382 of them for all clients. A list
// of more than 50 values pads to a fixed size by its last value, and an insert chunk takes
// a fixed size. The pad must change no answer.

const opened: MysqlDatabase[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

const at = new Date("2026-10-24T00:00:00.000Z");
const member = (i: number) => ({
  id: `gm-${String(i).padStart(4, "0")}`,
  groupId: "g1",
  scimUserId: `su-${i}`,
  createdAt: at,
  updatedAt: at,
});

for (const server of MYSQL_SERVERS) {
  describe(`the fixed list sizes on MySQL ${server.version}`, () => {
    it("reads, updates, and deletes by a padded in list with the answers of the list", async () => {
      const db = await freshDatabase(server);
      opened.push(db);
      const adapter = createMysqlAdapter(db.pool);
      await adapter.createMany(
        "scimGroupMember",
        Array.from({ length: 100 }, (_, i) => member(i)),
      );
      // 70 values pad to 128 by a repeat of the last one.
      const ids = Array.from({ length: 70 }, (_, i) => member(i).id);
      const inIds = [{ field: "id" as const, op: "in" as const, value: ids }];
      expect((await adapter.findMany("scimGroupMember", inIds)).map((r) => r.id).sort()).toEqual(
        ids,
      );
      expect(await adapter.update("scimGroupMember", inIds, { groupId: "g2" })).toBe(70);
      expect(
        await adapter.delete("scimGroupMember", [
          { field: "id", op: "in", value: ids.slice(0, 60) },
        ]),
      ).toBe(60);
      const left = await adapter.findMany("scimGroupMember", [], {
        sort: { field: "id", dir: "asc" },
      });
      expect(left.map((r) => [r.id, r.groupId])).toEqual([
        ...ids.slice(60).map((id) => [id, "g2"]),
        ...Array.from({ length: 30 }, (_, i) => [member(70 + i).id, "g1"]),
      ]);
    });

    it("inserts 999 rows in the fixed sizes 512, 256, 128, 64, and 39, all or nothing", async () => {
      const db = await freshDatabase(server);
      opened.push(db);
      const adapter = createMysqlAdapter(db.pool);
      const rows = Array.from({ length: 999 }, (_, i) => member(i));
      await adapter.findMany("scimGroupMember", []);
      const before = adapter.statementsSent?.() ?? 0;
      await adapter.createMany("scimGroupMember", rows);
      expect((adapter.statementsSent?.() ?? 0) - before).toBe(5);
      expect(
        await adapter.findMany("scimGroupMember", [], { sort: { field: "id", dir: "asc" } }),
      ).toEqual(rows);
      // A clash in the last chunk keeps no row of the call.
      const again = Array.from({ length: 999 }, (_, i) => member(1000 + i));
      again[998] = member(0);
      await expect(adapter.createMany("scimGroupMember", again)).rejects.toMatchObject({
        code: "unique_violation",
      });
      expect(await adapter.findMany("scimGroupMember", [])).toHaveLength(999);
    });

    it("prepares 56 statements on one connection for in lists of 1 to 2000 values", async () => {
      const db = await freshDatabase(server);
      opened.push(db);
      // One connection, so the session counter of prepares holds every statement.
      const pool = db.pool2({ connectionLimit: 1 });
      const adapter = createMysqlAdapter(pool);
      const prepares = async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          "SHOW SESSION STATUS LIKE 'Com_stmt_prepare'",
        );
        return Number(rows[0]?.Value);
      };
      // The version check of the first call prepares its own statements first.
      await adapter.findMany("scimGroupMember", [{ field: "id", op: "eq", value: "none" }]);
      const before = await prepares();
      for (let n = 1; n <= 2000; n++) {
        const value = Array.from({ length: n }, (_, i) => `gm-${i}`);
        await adapter.findMany("scimGroupMember", [{ field: "id", op: "in", value }]);
      }
      expect((await prepares()) - before).toBe(56);
    }, 120_000);
  });
}
