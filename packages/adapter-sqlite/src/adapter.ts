import {
  createD1AdapterOn,
  createD1Limiter,
  type D1Subset,
  schemaVersionCheckOn,
  schemaVersionPing,
  toStorageError,
} from "@authtempo/adapter-d1/seam";
import type { Clock, LimiterPort, StorageAdapter } from "@authtempo/core";
import { coreStatements, SQLITE, type Statement } from "@authtempo/core/sql";
import { integerProbe } from "./probe.js";

/** One SQLite database through one driver (plan 12g). The app opens the database; the entry wraps the handle. */
export interface SqliteDriver {
  readonly name: "node:sqlite" | "better-sqlite3" | "bun:sqlite" | "libsql";
  readonly db: D1Subset;
  /** Runs `script` and `record` in one write transaction when `done` answers no row. Answers true when it ran. */
  migrateStep(done: Statement, script: string, record: Statement): Promise<boolean>;
  /** `SELECT sqlite_version()`. */
  sqliteVersion(): Promise<string>;
}

/**
 * The storage port on SQLite: the D1 adapter's own code over the seam, so
 * every driver runs the D1 undo log with its two limits (spec 6). Before the
 * first call, the adapter checks that the handle reads integers as numbers,
 * then checks the schema version. Both queries count in `statementsSent` and
 * in `readyStatements` (2 on a pass). `ping` reads the schema version with
 * no cache, each call, as on D1 (ruling 26 of the 12g lane, plan 12h Task 8).
 * Its one query counts in `statementsSent` only.
 */
export function createSqliteAdapter(driver: SqliteDriver): StorageAdapter {
  const sent = { statements: 0, ready: 0 };
  const probe = integerProbe(driver.db, sent);
  const version = schemaVersionCheckOn(driver.db, sent);
  return createD1AdapterOn(driver.db, {
    statements: coreStatements(SQLITE),
    toStorageError,
    ready: async () => {
      await probe();
      await version();
    },
    ping: schemaVersionPing(driver.db, sent),
    sent,
  });
}

/** The limiter the product owns on SQLite: the D1 limiter over the seam, kept in `ta_limit`. */
export function createSqliteLimiter(driver: SqliteDriver, clock?: Clock): LimiterPort {
  return createD1Limiter(driver.db, clock);
}
