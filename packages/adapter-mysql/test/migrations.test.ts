import { schemaDdl } from "@authtempo/core/ddl";
import { MYSQL } from "@authtempo/core/sql";
import type { RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { statements as baseline } from "../src/migrations/0001_schema_v13.js";
import {
  applyMysqlMigrations,
  applyMysqlMigrationsWith,
  MYSQL_MIGRATIONS,
  stepMade,
} from "../src/migrations.js";
import { readMysqlShape } from "../src/shape.js";
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

/** The runner that stops after the DDL of step `at` and before its record, as a crash there does. */
async function stopAfter(d: MysqlDatabase, at: number): Promise<void> {
  let ran = 0;
  const stopped = await applyMysqlMigrationsWith(d.pool, async (conn, sql) => {
    ran += 1;
    await conn.query(sql);
    if (ran === at) throw new Error(`stop after step ${at}`);
  }).catch((e: unknown) => e);
  expect(stopped).toMatchObject({ message: `stop after step ${at}` });
}

/** The error of `sql` on the pool's database, or null when it runs. */
async function errorOf(d: MysqlDatabase, sql: string): Promise<unknown> {
  return d.pool.query(sql).then(
    () => null,
    (e: unknown) => e,
  );
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

    it("finishes a run that stopped between a step and its record", async () => {
      const clean = await freshDatabase(server);
      const cleanShape = await readMysqlShape(clean.pool);
      await clean.close();
      const last = ALL_STEPS.length;
      for (const at of [2, last]) {
        db = await freshDatabase(server, { migrate: false });
        await stopAfter(db, at);
        // The step ran, and its record is missing.
        expect(await recorded(db)).toEqual(ALL_STEPS.slice(0, at - 1));
        expect(await applyMysqlMigrations(db.pool)).toEqual(MYSQL_MIGRATIONS.map((m) => m.name));
        expect(await recorded(db)).toEqual(ALL_STEPS);
        expect(await version(db)).toBe("13");
        expect(await readMysqlShape(db.pool)).toEqual(cleanShape);
        await db.close();
        db = null;
      }
    });

    it("stops when the object of an unrecorded step is not the one the step makes", async () => {
      db = await freshDatabase(server, { migrate: false });
      await stopAfter(db, 2);
      await db.q`ALTER TABLE ta_identity ADD COLUMN extra INT`;
      const stopped = await applyMysqlMigrations(db.pool).catch((e: unknown) => e);
      expect(String((stopped as Error).message)).toMatch(
        /^authtempo migrations: step 2 of 0001_schema_v13 failed with 1050, and its object is not the one the step makes/,
      );
      expect(await recorded(db)).toEqual(ALL_STEPS.slice(0, 1));
      await db.close();
      // The version row of another value is not the row the last step makes.
      db = await freshDatabase(server, { migrate: false });
      await stopAfter(db, ALL_STEPS.length);
      await db.q`UPDATE ta_meta SET value = '12' WHERE ${db.q("key")} = 'schema_version'`;
      const stoppedRow = await applyMysqlMigrations(db.pool).catch((e: unknown) => e);
      expect(String((stoppedRow as Error).message)).toMatch(
        /failed with 1062, and its object is not/,
      );
      expect(await version(db)).toBe("12");
    });

    it("checks a column and an index step by its live table", async () => {
      db = await freshDatabase(server, { migrate: false });
      await db.q`CREATE TABLE t (id INT PRIMARY KEY, a INT)`;
      const add = "ALTER TABLE `t` ADD COLUMN `b` VARCHAR(10) NOT NULL, ADD KEY `ix_b` (`b`)";
      const index = "CREATE UNIQUE INDEX `ux_a` ON `t` (`a`)";
      await db.pool.query(add);
      await db.pool.query(index);
      const conn = await db.pool.getConnection();
      try {
        expect(await stepMade(conn, add, await errorOf(db, add))).toBe(true);
        expect(await stepMade(conn, index, await errorOf(db, index))).toBe(true);
        // Another type of the column, or another column of the index, is not the step.
        await db.q`ALTER TABLE t MODIFY COLUMN b VARCHAR(20) NOT NULL`;
        expect(await stepMade(conn, add, await errorOf(db, add))).toBe(false);
        await db.q`DROP INDEX ux_a ON t`;
        await db.q`CREATE UNIQUE INDEX ux_a ON t (id, a)`;
        expect(await stepMade(conn, index, await errorOf(db, index))).toBe(false);
        // An error that is not about an object that exists is never a made step.
        const other = "ALTER TABLE `t` ADD COLUMN `c` INT NOT NULL DEFAULT 'x'";
        expect(await stepMade(conn, other, await errorOf(db, other))).toBe(false);
      } finally {
        conn.release();
      }
    });

    it("holds the baseline to schemaDdl", () => {
      // One source on the day of the baseline (2026-10-21). After this task
      // the file is a record, and the shape suite holds it.
      expect(baseline).toEqual(schemaDdl(MYSQL));
      expect(MYSQL_MIGRATIONS.map((m) => m.name)).toEqual(["0001_schema_v13"]);
    });
  });
}
