import type { RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import {
  databaseSupply,
  dropStaleDatabases,
  freshDatabase,
  MYSQL_SERVERS,
  type MysqlDatabase,
  testDatabaseName,
} from "./db.js";

const HOUR = 60 * 60 * 1000;

/** The test databases of the server of `d` among `names`. */
async function present(d: MysqlDatabase, names: string[]): Promise<string[]> {
  const rows = await d.q<
    RowDataPacket[]
  >`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
    WHERE SCHEMA_NAME LIKE 't\\_%'`;
  return rows
    .map((r) => String(r.name))
    .filter((n) => names.includes(n))
    .sort();
}

for (const server of MYSQL_SERVERS) {
  describe(`the test database supply on MySQL ${server.version}`, () => {
    it("drops the databases of a killed run at the start, and keeps the young ones", async () => {
      // A run that was killed two hours ago left this database.
      const old = await freshDatabase(server, {
        migrate: false,
        name: testDatabaseName(Date.now() - 2 * HOUR),
      });
      const young = await freshDatabase(server, { migrate: false });
      const legacy = await freshDatabase(server, {
        migrate: false,
        name: `t_${crypto.randomUUID().replaceAll("-", "")}`,
      });
      await legacy.q`CREATE TABLE t (id INT PRIMARY KEY)`;
      const names = [old.name, young.name, legacy.name];
      const supply = databaseSupply(server, 1);
      const taken = await supply.take();
      try {
        expect(await present(young, names)).toEqual([young.name, legacy.name].sort());
        // A second sweep drops none of the two that are left.
        const again = await dropStaleDatabases(server);
        expect(again.filter((n) => names.includes(n))).toEqual([]);
      } finally {
        await taken.close();
        await supply.drain();
        for (const d of [old, young, legacy]) await d.close();
      }
    });
  });
}
