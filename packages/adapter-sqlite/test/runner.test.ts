import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "@authtempo/core";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { betterSqlite3 } from "../src/better-sqlite3.js";
import { applySqliteMigrations, createSqliteAdapter, SQLITE_MIGRATIONS } from "../src/index.js";
import { libsql } from "../src/libsql.js";
import { runSqliteMigrations } from "../src/migrations.js";
import { nodeSqlite } from "../src/node.js";
import { DRIVER_KINDS, type DriverKind, openDriver, tempFolder } from "./support/drivers.js";

const NAMES = SQLITE_MIGRATIONS.map((m) => m.name);

async function rows(d: ReturnType<typeof openDriver>, sql: string) {
  return (await d.driver.db.prepare(sql).all()).results;
}

/** Each driver opened with its BigInt setting on, as an app could open it. */
function openBigInt(kind: DriverKind, dir: string) {
  switch (kind) {
    case "node": {
      const db = new DatabaseSync(":memory:", { readBigInts: true });
      return { driver: nodeSqlite(db), close: () => db.close() };
    }
    case "better-sqlite3": {
      const db = new Database(":memory:");
      db.defaultSafeIntegers(true);
      return { driver: betterSqlite3(db), close: () => db.close() };
    }
    case "libsql-file": {
      const client = createClient({ url: `file:${join(dir, "bigint.sqlite")}`, intMode: "bigint" });
      return { driver: libsql(client), close: () => client.close() };
    }
  }
}

describe.each(DRIVER_KINDS)("sqlite runner on %s", (kind) => {
  it("applies every migration once and records it", async () => {
    const d = openDriver(kind);
    try {
      expect(await applySqliteMigrations(d.driver)).toEqual(NAMES);
      expect(await applySqliteMigrations(d.driver)).toEqual([]);
      const recorded = await rows(d, "SELECT name FROM ta_migrations ORDER BY name");
      expect(recorded.map((r) => r.name)).toEqual(NAMES);
      const version = await rows(d, "SELECT value FROM ta_meta WHERE key = 'schema_version'");
      expect(version).toEqual([{ value: String(SCHEMA_VERSION) }]);
    } finally {
      d.close();
    }
  });

  it("two runners on one file apply each migration once", async () => {
    const folder = tempFolder();
    const file = join(folder.dir, "shared.sqlite");
    const a = openDriver(kind, file);
    const b = openDriver(kind, file);
    try {
      const [ranA, ranB] = await Promise.all([
        applySqliteMigrations(a.driver),
        applySqliteMigrations(b.driver),
      ]);
      expect([...ranA, ...ranB].sort()).toEqual(NAMES);
      const recorded = await rows(a, "SELECT name FROM ta_migrations ORDER BY name");
      expect(recorded.map((r) => r.name)).toEqual(NAMES);
    } finally {
      a.close();
      b.close();
      folder.remove();
    }
  });

  it("a failed migration writes nothing of itself", async () => {
    const d = openDriver(kind);
    const broken = {
      name: "9999_broken",
      sql: "CREATE TABLE ta_broken (id TEXT PRIMARY KEY NOT NULL);\nINSERT INTO ta_no_such_table (id) VALUES ('x');",
    };
    try {
      await expect(runSqliteMigrations(d.driver, [...SQLITE_MIGRATIONS, broken])).rejects.toThrow(
        /no such table/,
      );
      const tables = await rows(d, "SELECT name FROM sqlite_master WHERE name = 'ta_broken'");
      expect(tables).toEqual([]);
      const recorded = await rows(d, "SELECT name FROM ta_migrations ORDER BY name");
      expect(recorded.map((r) => r.name)).toEqual(NAMES);
    } finally {
      d.close();
    }
  });

  it("refuses a handle that reads integers as BigInt", async () => {
    const folder = tempFolder();
    const d = openBigInt(kind, folder.dir);
    try {
      const db = createSqliteAdapter(d.driver);
      const err = await db.findMany("user", []).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "StorageError", code: "config_mismatch" });
      expect((err as Error).message).toContain(
        "the driver reads integers as BigInt; open the database without readBigInts, safeIntegers, or intMode bigint",
      );
    } finally {
      d.close();
      folder.remove();
    }
  });

  it("answers null for no row from first()", async () => {
    const d = openDriver(kind);
    try {
      expect(await d.driver.db.prepare("SELECT 1 WHERE 0").first()).toBeNull();
    } finally {
      d.close();
    }
  });

  it("counts the probe in readyStatements", async () => {
    const d = openDriver(kind);
    try {
      await applySqliteMigrations(d.driver);
      const db = createSqliteAdapter(d.driver);
      expect(await db.readyStatements?.()).toBe(2);
      expect(await db.findMany("user", [])).toEqual([]);
      expect(await db.readyStatements?.()).toBe(2);
    } finally {
      d.close();
    }
  });
});
