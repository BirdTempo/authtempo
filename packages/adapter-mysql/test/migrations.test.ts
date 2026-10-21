import { schemaDdl } from "@authtempo/core/ddl";
import { MYSQL } from "@authtempo/core/sql";
import type { RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { statements as baseline } from "../src/migrations/0001_schema_v13.js";
import {
  applyMysqlMigrations,
  applyMysqlMigrationsWith,
  MYSQL_MIGRATIONS,
} from "../src/migrations.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** Every step of every migration, as `<name>:<step>`. */
const ALL_STEPS = MYSQL_MIGRATIONS.flatMap((m) => m.statements.map((_, i) => `${m.name}:${i + 1}`));

async function recorded(d: MysqlDatabase): Promise<string[]> {
  const rows = await d.q<RowDataPacket[]>`SELECT name, step FROM ta_migrations ORDER BY name, step`;
  return rows.map((r) => `${r.name}:${r.step}`);
}

/** The version row, or null when ta_meta does not exist or has no row. */
async function version(d: MysqlDatabase): Promise<string | null> {
  const rows = await d.q<RowDataPacket[]>`SELECT TABLE_NAME FROM information_schema.tables
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ta_meta'`;
  if (rows.length === 0) return null;
  const meta = await d.q<
    RowDataPacket[]
  >`SELECT value FROM ta_meta WHERE ${d.q("key")} = 'schema_version'`;
  return (meta[0]?.value as string | undefined) ?? null;
}

for (const server of MYSQL_SERVERS) {
  describe(`the MySQL migration runner on ${server.version}`, () => {
    it("applies the baseline once from two pools at once", async () => {
      db = await freshDatabase(server, { migrate: false });
      const results = await Promise.all([
        applyMysqlMigrations(db.pool),
        applyMysqlMigrations(db.pool2()),
      ]);
      // The lock lets one runner apply every step; the other finds each step recorded.
      expect(results.flat()).toEqual(MYSQL_MIGRATIONS.map((m) => m.name));
      expect(await recorded(db)).toEqual(ALL_STEPS);
      expect(await version(db)).toBe("13");
      expect(await applyMysqlMigrations(db.pool)).toEqual([]);
    });

    it("resumes a migration after a failed step", async () => {
      db = await freshDatabase(server, { migrate: false });
      let ran = 0;
      // The runner stops after its second step: the third throws once.
      const stopped = await applyMysqlMigrationsWith(db.pool, async (conn, sql) => {
        ran += 1;
        if (ran === 3) throw new Error("stop at step 3");
        await conn.query(sql);
      }).catch((e: unknown) => e);
      expect(stopped).toMatchObject({ message: "stop at step 3" });
      expect(await recorded(db)).toEqual(["0001_schema_v13:1", "0001_schema_v13:2"]);
      expect(await version(db)).toBeNull();
      expect(await applyMysqlMigrations(db.pool)).toEqual(MYSQL_MIGRATIONS.map((m) => m.name));
      expect(await recorded(db)).toEqual(ALL_STEPS);
      expect(await version(db)).toBe("13");
      // The third step made its table: a step recorded before it ran would leave it out.
      const tables = await db.q<RowDataPacket[]>`SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ta\\_%'`;
      // 27 model tables, ta_meta, ta_limit, and ta_migrations.
      expect(Number(tables[0]?.n)).toBe(30);
    });

    it("holds the baseline to schemaDdl", () => {
      // One source on the day of the baseline (2026-10-21). After this task
      // the file is a record, and the shape suite holds it.
      expect(baseline).toEqual(schemaDdl(MYSQL));
      expect(MYSQL_MIGRATIONS.map((m) => m.name)).toEqual(["0001_schema_v13"]);
    });
  });
}
