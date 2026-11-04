import { createHash } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
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
      expect(await version(db)).toBe("16");
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
      expect(await version(db)).toBe("16");
      // The third step made its table: a step recorded before it ran would leave it out.
      const tables = await db.q<RowDataPacket[]>`SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ta\\_%'`;
      // 27 model tables of version 13, 6 of version 14, ta_meta, ta_limit, and ta_migrations.
      expect(Number(tables[0]?.n)).toBe(36);
    });

    it("finishes a run that stopped between a step and its record", async () => {
      const clean = await freshDatabase(server);
      const cleanShape = await readMysqlShape(clean.pool);
      await clean.close();
      const last = ALL_STEPS.length;
      // The stops include the version row of the baseline, and the ALTER of 0003 with the
      // user columns and their unique keys (plan 12i). They also include the column and the
      // fill of 0004 (plan 12p), and the version update of the last file. The fill sets the
      // same value when it runs again.
      const userColumns = ALL_STEPS.indexOf("0003_schema_v15:2") + 1;
      const proved = ALL_STEPS.indexOf("0004_schema_v16:1") + 1;
      const fill = ALL_STEPS.indexOf("0004_schema_v16:2") + 1;
      expect(userColumns).toBeGreaterThan(baseline.length);
      expect([proved > userColumns, fill, last]).toEqual([true, proved + 1, fill + 1]);
      for (const at of [2, baseline.length, userColumns, proved, fill, last]) {
        db = await freshDatabase(server, { migrate: false });
        await stopAfter(db, at);
        // The step ran, and its record is missing.
        expect(await recorded(db)).toEqual(ALL_STEPS.slice(0, at - 1));
        // The run changes each file from the one of the step on.
        const file = (ALL_STEPS[at - 1] ?? "").split(":")[0];
        const open = MYSQL_MIGRATIONS.slice(MYSQL_MIGRATIONS.findIndex((m) => m.name === file));
        expect(await applyMysqlMigrations(db.pool)).toEqual(open.map((m) => m.name));
        expect(await recorded(db)).toEqual(ALL_STEPS);
        expect(await version(db)).toBe("16");
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
      // The version row of another value is not the row the last step of the baseline makes.
      db = await freshDatabase(server, { migrate: false });
      await stopAfter(db, baseline.length);
      await db.q`UPDATE ta_meta SET value = '12' WHERE ${db.q("key")} = 'schema_version'`;
      const stoppedRow = await applyMysqlMigrations(db.pool).catch((e: unknown) => e);
      expect(String((stoppedRow as Error).message)).toMatch(
        /failed with 1062, and its object is not/,
      );
      expect(await version(db)).toBe("12");
    });

    it("stops with the step when the user cannot make a temporary table", async () => {
      db = await freshDatabase(server, { migrate: false });
      await stopAfter(db, 2);
      // A user with the privileges of the steps, without CREATE TEMPORARY TABLES.
      const user = `ta_nt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await db.pool.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'nt'`);
      const u = new URL(server.url);
      const pool = mysql.createPool({
        host: u.hostname,
        port: Number(u.port),
        user,
        password: "nt",
        database: db.name,
        connectionLimit: 1,
      });
      try {
        await db.pool.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON \`${db.name}\`.* TO '${user}'@'%'`,
        );
        const stopped = await applyMysqlMigrations(pool).catch((e: unknown) => e);
        expect(String((stopped as Error).message)).toMatch(
          /^authtempo migrations: step 2 of 0001_schema_v13 failed with 1050, and the check of its object failed with 1044\. No later step ran\. The check needs the CREATE TEMPORARY TABLES privilege/,
        );
        expect((stopped as Error).cause).toMatchObject({ errno: 1044 });
        expect(await recorded(db)).toEqual(ALL_STEPS.slice(0, 1));
      } finally {
        await pool.end();
        await db.pool.query(`DROP USER IF EXISTS '${user}'@'%'`);
      }
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

    it("fills proved from the user of each session at schema version 16 (plan 12p)", async () => {
      const d = await freshDatabase(server, { migrate: false });
      db = d;
      const [column] = MYSQL_MIGRATIONS.find((m) => m.name === "0004_schema_v16")?.statements ?? [];
      // The runner stops before the first step of 0004: the database is at version 15.
      const stopped = await applyMysqlMigrationsWith(d.pool, async (conn, sql) => {
        if (sql === column) throw new Error("stop before 0004");
        await conn.query(sql);
      }).catch((e: unknown) => e);
      expect(stopped).toMatchObject({ message: "stop before 0004" });
      expect(await version(d)).toBe("15");
      // A verified user with an address, a claimant with an unverified address, and a phone
      // user with no address. Each has a live session, as a writer of version 15 makes them.
      const user = (id: string, email: string | null, verified: number, phone: string | null) =>
        d.pool.query(
          "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES (?, 1, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0)",
          [id, email, verified, phone],
        );
      const session = (id: string, userId: string) =>
        d.pool.query(
          "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, ip, user_agent, active_organization_id, fresh_at, actor_id, active_team_id) VALUES (?, 1, 1, ?, ?, 4102444800000, 1, NULL, NULL, NULL, 1, NULL, NULL)",
          [id, userId, `h-${id}`],
        );
      await user("uv", "uv@example.com", 1, null);
      await user("uu", "uu@example.com", 0, null);
      await user("un", null, 0, "+14155550100");
      for (const [id, userId] of [
        ["sv", "uv"],
        ["sv2", "uv"],
        ["su", "uu"],
        ["sn", "un"],
      ] as const)
        await session(id, userId);
      expect(await applyMysqlMigrations(d.pool)).toEqual(["0004_schema_v16"]);
      expect(await version(d)).toBe("16");
      const rows = await d.q<RowDataPacket[]>`SELECT id, proved FROM ta_session ORDER BY id`;
      expect(rows.map((r) => [r.id, r.proved])).toEqual([
        ["sn", 0],
        ["su", 0],
        ["sv", 1],
        ["sv2", 1],
      ]);
      const [meta] = await d.pool.query<RowDataPacket[]>(
        "SELECT IS_NULLABLE AS n, COLUMN_DEFAULT AS d, COLUMN_TYPE AS t FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ta_session' AND COLUMN_NAME = 'proved'",
      );
      expect(meta.map((r) => [r.n, r.d, r.t])).toEqual([["NO", "0", "tinyint(1)"]]);
      // A writer of version 15 after the fill names no proved: the default gives false.
      await session("sv3", "uv");
      const late = await d.q<RowDataPacket[]>`SELECT proved FROM ta_session WHERE id = 'sv3'`;
      expect(late.map((r) => r.proved)).toEqual([0]);
    });

    it("holds the baseline record to its digest", () => {
      // The record 0001_schema_v13 is append-only. On 2026-10-21 its text was
      // schemaDdl(MYSQL). Schema 14 changes schemaDdl, and a compare with it
      // then fails on a record that did not change (plan 12g fix wave, m2).
      // The digest pins the record text alone. The shape suite holds the
      // live tables to the schema.
      const digest = createHash("sha256").update(JSON.stringify(baseline)).digest("hex");
      expect(digest).toBe("1c55f449b21a23f5aa8d489d1877d276c88d504e275929993cedffbe0a94bbd9");
      // Plan 12d appends the file of schema version 14 after it, plan 12i the file of 15,
      // and plan 12p the file of 16.
      expect(MYSQL_MIGRATIONS.map((m) => m.name)).toEqual([
        "0001_schema_v13",
        "0002_schema_v14",
        "0003_schema_v15",
        "0004_schema_v16",
      ]);
    });

    it("holds each shipped record to its digest (ruling 81 l3 of plan 12d)", () => {
      // Each shipped file is append-only, as the baseline is. A later file gets its pin here
      // when it ships, so an edit of a shipped file fails with no compare to schemaDdl.
      const digests = MYSQL_MIGRATIONS.map((m) => [
        m.name,
        createHash("sha256").update(JSON.stringify(m.statements)).digest("hex"),
      ]);
      expect(digests).toEqual([
        ["0001_schema_v13", "1c55f449b21a23f5aa8d489d1877d276c88d504e275929993cedffbe0a94bbd9"],
        ["0002_schema_v14", "35a0f032d884b2ff0f117fa6d4e2b46dbdf76324930afca6e9ba332b8761f03b"],
        // Schema 15 exists only on the plan 12i lane, so its file can still change (ruling 25).
        // Ruling 25 H1 of plan 12i (2026-10-24) added the key on (is_anonymous, created_at)
        // before 0003 left the lane. No database outside the tests ran the old text.
        // Plan 12i Task 18 added the issuer of the logout tables on 2026-10-25.
        ["0003_schema_v15", "d08a803c1d282c2f512b9f0acc857baca8e63ea382d22a2460a1f61d8b48a59e"],
        // Plan 12p Task 1 (2026-11-04): the proof mark of the session and its fill.
        ["0004_schema_v16", "56442d040411910b0b8da831efa1508c2a04fea5b002726e6145ccf9a98a71da"],
      ]);
    });
  });
}
