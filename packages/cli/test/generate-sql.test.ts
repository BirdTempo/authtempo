import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectedMysqlShape, readMysqlShape } from "@authtempo/adapter-mysql";
import { expectedPostgresShape, readPostgresShape } from "@authtempo/adapter-postgres";
import { expectedSqliteShape, readSqliteShape } from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { withoutDefaults } from "@authtempo/core/shape-conformance";
import mysql from "mysql2/promise";
import { beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, runBin } from "./support/bin.js";
import { freshMysqlDatabase, MYSQL_SERVERS } from "./support/mysql.js";
import { freshDatabase } from "./support/pg.js";

// `authtempo generate --format sql` (plan 12g Task 7). The printed SQL goes
// into an empty database with no CLI in between. Then `migrate --dry-run`
// must find nothing to do, and the live shape must be the shape that the
// adapter's own migrations build.

/** The names of the shipped SQLite and Postgres migrations, typed here. */
const CORE = Array.from({ length: 14 }, (_, i) => {
  const n = String(i + 1);
  return `${n.padStart(4, "0")}_schema_v${n}`;
});

beforeAll(() => {
  assertFreshBuild();
});

/** The SQL of one dialect, printed by the built CLI. */
function printed(dialect: string): string {
  const r = runBin(["generate", "--format", "sql", "--dialect", dialect]);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** The statements of the printed text: each comment line out, then a split at each `;` that ends a line. */
const statementsOf = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(/;\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The runner records: the statements after the comment that names them. */
function records(text: string): string[] {
  const at = text.indexOf("-- The records are safe only because");
  expect(at).toBeGreaterThan(0);
  return statementsOf(text.slice(at));
}

/** The JSON document of `migrate --dry-run --json` with the URL in a variable of the child. */
function dryRun(target: string, args: string[], env: Record<string, string> = {}) {
  const r = runBin(["migrate", "--target", target, ...args, "--dry-run", "--json"], { env });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { before: number | null; pending: string[]; applied: string[] };
}

describe("authtempo generate --format sql (plan 12g Task 7)", () => {
  it("builds the shipped shape and leaves migrate nothing to do: sqlite", async () => {
    const text = printed("sqlite");
    const rows = records(text);
    expect(rows[0]).toMatch(/^CREATE TABLE IF NOT EXISTS ta_migrations \(/);
    expect(rows.slice(1).map((s) => /VALUES \('([^']+)'/.exec(s)?.[1])).toEqual(CORE);

    const dir = mkdtempSync(join(tmpdir(), "authtempo-cli-generate-sql-"));
    try {
      const file = join(dir, "app.db");
      const db = new DatabaseSync(file);
      try {
        db.exec(text);
        expect(withoutDefaults(await readSqliteShape(nodeSqlite(db)))).toEqual(
          expectedSqliteShape(),
        );
      } finally {
        db.close();
      }
      const doc = dryRun("sqlite", ["--file", file]);
      expect(doc).toMatchObject({ before: 14, pending: [], applied: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the shipped shape and leaves migrate nothing to do: postgres", async () => {
    const text = printed("postgres");
    const rows = records(text);
    expect(rows[0]).toMatch(/^CREATE TABLE IF NOT EXISTS ta_migrations \(/);
    expect(rows.slice(1).map((s) => /VALUES \('([^']+)'/.exec(s)?.[1])).toEqual(CORE);

    const db = await freshDatabase();
    try {
      await db.sql.unsafe(text);
      expect(withoutDefaults(await readPostgresShape(db.sql))).toEqual(expectedPostgresShape());
      const doc = dryRun("postgres", ["--url-env", "TEST_DB_URL"], { TEST_DB_URL: db.url });
      expect(doc).toMatchObject({ before: 14, pending: [], applied: [] });
    } finally {
      await db.drop();
    }
  });

  it("builds the shipped shape and leaves migrate nothing to do: mysql 8.4", async () => {
    const text = printed("mysql");
    const rows = records(text);
    expect(rows[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `ta_migrations` \(/);
    // The runner records each step: the baseline 0001_schema_v13 has 30 steps,
    // and 0002_schema_v14 of plan 12d has 7.
    expect(rows.slice(1).map((s) => /VALUES \('([^']+)', (\d+),/.exec(s)?.slice(1))).toEqual([
      ...Array.from({ length: 30 }, (_, i) => ["0001_schema_v13", String(i + 1)]),
      ...Array.from({ length: 7 }, (_, i) => ["0002_schema_v14", String(i + 1)]),
    ]);

    const server = MYSQL_SERVERS[0];
    const db = await freshMysqlDatabase(server);
    const pool = mysql.createPool({ uri: db.url, connectionLimit: 1, timezone: "Z" });
    try {
      for (const statement of statementsOf(text)) await pool.query(statement);
      expect(withoutDefaults(await readMysqlShape(pool))).toEqual(expectedMysqlShape());
      const doc = dryRun("mysql", ["--url-env", "MYSQL_URL"], { MYSQL_URL: db.url });
      expect(doc).toMatchObject({ before: 14, pending: [], applied: [] });
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
