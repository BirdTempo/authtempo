import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { SqliteDriver } from "../src/adapter.js";
import { betterSqlite3 } from "../src/better-sqlite3.js";
import { nodeSqlite } from "../src/node.js";
import { DRIVER_KINDS, openDriver, tempFolder } from "./support/drivers.js";

const SYNC_KINDS = ["node", "better-sqlite3"] as const;
type SyncKind = (typeof SYNC_KINDS)[number];

/** A raw handle of one synchronous driver, with the facts that the tests read from it. */
interface RawHandle {
  driver: SqliteDriver;
  exec(sql: string): void;
  rows(sql: string): Record<string, unknown>[];
  inTransaction(): boolean;
  /** Closes the handle. A second call does nothing. */
  close(): void;
}

function openRaw(kind: SyncKind, file: string): RawHandle {
  switch (kind) {
    case "node": {
      const db = new DatabaseSync(file);
      return {
        driver: nodeSqlite(db),
        exec: (sql) => db.exec(sql),
        rows: (sql) =>
          db
            .prepare(sql)
            .all()
            .map((r) => ({ ...r })),
        inTransaction: () => db.isTransaction,
        close: () => {
          if (db.isOpen) db.close();
        },
      };
    }
    case "better-sqlite3": {
      // The default busy wait of better-sqlite3 is 5 s. A short wait keeps the test fast.
      const db = new Database(file, { timeout: 50 });
      return {
        driver: betterSqlite3(db),
        exec: (sql) => {
          db.exec(sql);
        },
        rows: (sql) => db.prepare(sql).all() as Record<string, unknown>[],
        inTransaction: () => db.inTransaction,
        close: () => {
          if (db.open) db.close();
        },
      };
    }
  }
}

describe.each(SYNC_KINDS)("a COMMIT that fails on %s", (kind) => {
  it("rolls back the batch, ends the transaction, and lets the next batch write", async () => {
    const folder = tempFolder();
    const file = join(folder.dir, "commit.sqlite");
    const writer = openRaw(kind, file);
    const reader = openRaw(kind, file);
    try {
      const db = writer.driver.db;
      await db.prepare("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)").run();
      // A second connection holds a read lock (SHARED), as a backup or a report query does.
      reader.exec("BEGIN");
      expect(reader.rows("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
      await expect(
        db.batch([db.prepare("INSERT INTO t (id) VALUES (?)").bind("a")]),
      ).rejects.toThrow(/database is locked/);
      expect(writer.inTransaction()).toBe(false);
      reader.exec("COMMIT");
      await db.batch([db.prepare("INSERT INTO t (id) VALUES (?)").bind("b")]);
      await db.prepare("INSERT INTO t (id) VALUES (?)").bind("c").run();
      expect(writer.inTransaction()).toBe(false);
      writer.close();
      expect(reader.rows("SELECT id FROM t ORDER BY id")).toEqual([{ id: "b" }, { id: "c" }]);
    } finally {
      writer.close();
      reader.close();
      folder.remove();
    }
  });

  it("rolls back a migration step and lets the next step run", async () => {
    const folder = tempFolder();
    const file = join(folder.dir, "migrate.sqlite");
    const writer = openRaw(kind, file);
    const reader = openRaw(kind, file);
    try {
      writer.exec("CREATE TABLE done (name TEXT PRIMARY KEY NOT NULL)");
      const done = { sql: "SELECT name FROM done WHERE name = ?", params: ["m1"] };
      const record = { sql: "INSERT INTO done (name) VALUES (?)", params: ["m1"] };
      const script = "CREATE TABLE m1 (id TEXT PRIMARY KEY NOT NULL);";
      reader.exec("BEGIN");
      expect(reader.rows("SELECT count(*) AS n FROM done")).toEqual([{ n: 0 }]);
      await expect(writer.driver.migrateStep(done, script, record)).rejects.toThrow(
        /database is locked/,
      );
      expect(writer.inTransaction()).toBe(false);
      reader.exec("COMMIT");
      expect(await writer.driver.migrateStep(done, script, record)).toBe(true);
      writer.close();
      expect(reader.rows("SELECT name FROM done")).toEqual([{ name: "m1" }]);
      expect(reader.rows("SELECT name FROM sqlite_master WHERE name = 'm1'")).toEqual([
        { name: "m1" },
      ]);
    } finally {
      writer.close();
      reader.close();
      folder.remove();
    }
  });
});

describe.each(SYNC_KINDS)("the changed-row count on %s", (kind) => {
  it("counts the parent row of a delete, not the rows of ON DELETE CASCADE", async () => {
    const folder = tempFolder();
    const h = openRaw(kind, join(folder.dir, "cascade.sqlite"));
    try {
      h.exec("PRAGMA foreign_keys = ON");
      h.exec(
        "CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL);" +
          "CREATE TABLE c (id TEXT PRIMARY KEY NOT NULL, p TEXT NOT NULL REFERENCES p (id) ON DELETE CASCADE);" +
          "INSERT INTO p (id) VALUES ('p1'), ('p2');" +
          "INSERT INTO c (id, p) VALUES ('c1', 'p1'), ('c2', 'p1'), ('c3', 'p2'), ('c4', 'p2');",
      );
      const db = h.driver.db;
      const run = await db.prepare("DELETE FROM p WHERE id = ?").bind("p1").run();
      expect(run.meta.changes).toBe(1);
      const [batched] = await db.batch([db.prepare("DELETE FROM p WHERE id = ?").bind("p2")]);
      expect(batched?.meta.changes).toBe(1);
      expect(h.rows("SELECT count(*) AS n FROM c")).toEqual([{ n: 0 }]);
    } finally {
      h.close();
      folder.remove();
    }
  });
});

describe.each(DRIVER_KINDS)("the update and delete counts on %s", (kind) => {
  it("answers the rows that each statement changed", async () => {
    const d = openDriver(kind);
    try {
      const db = d.driver.db;
      await db.prepare("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v INTEGER)").run();
      const insert = await db
        .prepare("INSERT INTO t (id, v) VALUES ('a', 0), ('b', 0), ('c', 0)")
        .run();
      expect(insert.meta.changes).toBe(3);
      const update = await db.prepare("UPDATE t SET v = 1 WHERE id IN (?, ?)").bind("a", "b").run();
      expect(update.meta.changes).toBe(2);
      // A read after a write changes no row: it answers 0, not the count of the write.
      expect((await db.prepare("SELECT id FROM t").all()).meta.changes).toBe(0);
      const none = await db.prepare("UPDATE t SET v = 2 WHERE id = ?").bind("x").run();
      expect(none.meta.changes).toBe(0);
      const results = await db.batch([
        db.prepare("UPDATE t SET v = 3 WHERE v = ?").bind(1),
        db.prepare("DELETE FROM t WHERE id = ?").bind("c"),
        db.prepare("DELETE FROM t WHERE id = ?").bind("x"),
      ]);
      expect(results.map((r) => r.meta.changes)).toEqual([2, 1, 0]);
      const deleted = await db.prepare("DELETE FROM t").run();
      expect(deleted.meta.changes).toBe(2);
    } finally {
      d.close();
    }
  });
});
