import { SCHEMA_VERSION } from "@authtempo/core";
import {
  runAdapterConformance,
  runRefreshRaceConformance,
  runSecretRotationConformance,
  runStoredFormConformance,
} from "@authtempo/core/conformance";
import { runLimiterConformance, runPhoneCapConformance } from "@authtempo/core/limiter-conformance";
import { runShapeConformance, type ShapeSide } from "@authtempo/core/shape-conformance";
import { SQLITE, TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import {
  applySqliteMigrations,
  createSqliteAdapter,
  createSqliteLimiter,
  expectedSqliteShape,
  readSqliteShape,
  SQLITE_MIGRATIONS,
  type SqliteDriver,
} from "../../src/index.js";
import { runSqliteMigrations } from "../../src/migrations.js";

/** One database that a run opened, and how to close it. */
export interface OpenedDriver {
  driver: SqliteDriver;
  close(): void | Promise<void>;
}

export interface SqliteRunOptions {
  /**
   * True when each `open` answers the one database of a server (libSQL over
   * HTTP). The suites then migrate it once and empty it before each test, as
   * the D1 test does. Otherwise each `open` answers a new empty database.
   */
  shared?: boolean;
}

function manualClock() {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function deleteRows(d: SqliteDriver, tables: readonly string[]): Promise<void> {
  await d.db.batch(tables.map((t) => d.db.prepare(`DELETE FROM ${t}`)));
}

/** Drops every `ta_` table, `ta_migrations` with them, so a side starts from an empty database. */
async function dropAll(d: SqliteDriver): Promise<void> {
  const tables = await d.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\'",
    )
    .all();
  for (const t of tables.results) await d.db.prepare(`DROP TABLE ${String(t.name)}`).run();
}

/** The live shape and the version row of one database. */
async function side(d: SqliteDriver): Promise<ShapeSide> {
  const row = await d.db
    .prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'")
    .first("value");
  return { shape: await readSqliteShape(d), version: typeof row === "string" ? row : null };
}

/**
 * Every core suite on one SQLite driver (plan 12g Task 4). The suites are the
 * storage conformance suite, the limiter suite, the secret rotation suite, the
 * two refresh race suites, and the shape check. `run` names each describe,
 * such as "storage conformance: node:sqlite".
 */
export function runSqliteSuites(
  run: string,
  open: () => Promise<OpenedDriver>,
  options: SqliteRunOptions = {},
): void {
  const shared = options.shared === true;
  // On a shared database: true while the tables of the migrations exist.
  let migrated = false;

  /** A migrated database with no row, for one test. */
  async function migratedDriver(): Promise<OpenedDriver> {
    const d = await open();
    if (!shared) {
      await applySqliteMigrations(d.driver);
      return d;
    }
    if (!migrated) {
      await dropAll(d.driver);
      await applySqliteMigrations(d.driver);
      migrated = true;
    }
    await deleteRows(d.driver, [...Object.values(TABLES), "ta_limit"]);
    return d;
  }

  async function storageTarget() {
    const d = await migratedDriver();
    return { adapter: createSqliteAdapter(d.driver), close: async () => d.close() };
  }

  /**
   * A new database with the migrations before the one of SCHEMA_VERSION
   * (plan 12h Task 8): an app has such a database before it runs the new
   * file. One server holds one database, so a shared run leaves it out.
   */
  async function oldStore() {
    const cut = SQLITE_MIGRATIONS.findIndex((m) =>
      m.name.startsWith(`${String(SCHEMA_VERSION).padStart(4, "0")}_`),
    );
    if (cut < 1) throw new Error(`no migration file of version ${SCHEMA_VERSION}`);
    const d = await open();
    await runSqliteMigrations(d.driver, SQLITE_MIGRATIONS.slice(0, cut));
    return { adapter: createSqliteAdapter(d.driver), close: async () => d.close() };
  }

  // SQLite sends an update in a transaction as 2 statements: the read for the undo and the write.
  // The adapter must have its ping (ruling 26 of the 12g lane).
  runAdapterConformance(run, storageTarget, {
    updateInTransaction: 2,
    ping: true,
    ...(shared ? {} : { oldStore }),
  });
  runSecretRotationConformance(run, storageTarget);
  runStoredFormConformance(run, async () => {
    const d = await migratedDriver();
    return {
      adapter: createSqliteAdapter(d.driver),
      all: async (sql) => (await d.driver.db.prepare(sql).all()).results,
      close: async () => d.close(),
    };
  });
  runRefreshRaceConformance(run, storageTarget);

  runLimiterConformance(run, async () => {
    const d = await migratedDriver();
    const clock = manualClock();
    return { limiter: createSqliteLimiter(d.driver, clock), clock, close: async () => d.close() };
  });

  // The daily cap of the phone code under 40 parallel sends (plan 12i Task 4).
  runPhoneCapConformance(run, async () => {
    const d = await migratedDriver();
    return {
      limiter: createSqliteLimiter(d.driver),
      storage: createSqliteAdapter(d.driver),
      close: async () => d.close(),
    };
  });

  runShapeConformance(run, async () => {
    const opened: OpenedDriver[] = [];
    async function fresh(): Promise<SqliteDriver> {
      const d = await open();
      opened.push(d);
      // One server holds one database: each side starts by dropping the other side's tables.
      if (shared) {
        migrated = false;
        await dropAll(d.driver);
      }
      return d.driver;
    }
    return {
      dialect: SQLITE,
      expected: expectedSqliteShape(),
      async shipped() {
        const d = await fresh();
        await applySqliteMigrations(d);
        return side(d);
      },
      async fromDdl(statements) {
        const d = await fresh();
        for (const s of statements) await d.db.prepare(s).run();
        return side(d);
      },
      async close() {
        const first = opened[0];
        if (shared && first !== undefined) await dropAll(first.driver);
        for (const d of opened) await d.close();
      },
    };
  });

  describe(`sqlite driver: ${run}`, () => {
    it("rolls back the whole batch when one statement fails", async () => {
      // The undo of an update reads the row and writes it in one batch, so the
      // batch must be one unit (spec 6, plan 12g). The table is the test's own.
      const d = await open();
      const db = d.driver.db;
      try {
        await db.prepare("DROP TABLE IF EXISTS zz_batch").run();
        await db.prepare("CREATE TABLE zz_batch (id TEXT PRIMARY KEY NOT NULL)").run();
        await db.prepare("INSERT INTO zz_batch (id) VALUES (?)").bind("a").run();
        const insert = (id: string) => db.prepare("INSERT INTO zz_batch (id) VALUES (?)").bind(id);
        await expect(db.batch([insert("b"), insert("a")])).rejects.toThrow(/UNIQUE/);
        const rows = await db.prepare("SELECT id FROM zz_batch ORDER BY id").all();
        expect(rows.results).toEqual([{ id: "a" }]);
      } finally {
        await db.prepare("DROP TABLE IF EXISTS zz_batch").run();
        await d.close();
      }
    });

    it("records the SQLite version of the driver", async () => {
      const d = await open();
      try {
        const version = await d.driver.sqliteVersion();
        console.log(`sqlite: ${run} ${version}`);
        const [major = 0, minor = 0] = version.split(".").map(Number);
        // 3.35 brought RETURNING, which the limiter's statement uses.
        expect(major * 1000 + minor, version).toBeGreaterThanOrEqual(3035);
      } finally {
        await d.close();
      }
    });
  });
}
