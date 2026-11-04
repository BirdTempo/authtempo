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
 * The bound parameters of one statement on SQLite: 32766, the default of
 * SQLITE_MAX_VARIABLE_NUMBER since SQLite 3.32.0 (sqlite.org limits page,
 * read 2026-10-24). A probe on 2026-10-24 found it in better-sqlite3
 * (SQLite 3.53.4) and libSQL file (3.45.1): 32767 fails. node:sqlite
 * (3.54.0) takes more. A statement holds at most `INSERT_ROWS_MAX` (1000)
 * rows, so this bound acts only on a model of more than 32 columns. The
 * conformance row at the chunk edge passed with 6553 rows on each driver,
 * Bun and libSQL over HTTP too, on 2026-10-24.
 */
export const SQLITE_BOUND_PARAMS = 32_766;

/**
 * The storage port on SQLite: the D1 adapter's own code over the seam, so
 * every driver runs the D1 undo log with its two limits (spec 6). Before the
 * first call, the adapter checks that the handle reads integers as numbers,
 * then checks the schema version. Both queries count in `statementsSent` and
 * in `readyStatements` (2 on a pass). `ping` runs the integer check first,
 * which keeps a pass and not a failure (ruling 27 of the 12g lane). Then it
 * reads the schema version with no cache, each call, as on D1 (ruling 26,
 * plan 12h Task 8). That query counts in `statementsSent` only.
 * The port calls `deleteRows` and `keep` of plan 12o are the D1 code too:
 * one DELETE … RETURNING, and the undo log. The conformance cases of both
 * passed on node:sqlite, better-sqlite3, bun:sqlite, and libSQL by file and
 * by HTTP on 2026-11-04.
 */
export function createSqliteAdapter(driver: SqliteDriver): StorageAdapter {
  const sent = { statements: 0, ready: 0 };
  const probe = integerProbe(driver.db, sent);
  const version = schemaVersionCheckOn(driver.db, sent);
  const read = schemaVersionPing(driver.db, sent);
  return createD1AdapterOn(driver.db, {
    statements: coreStatements(SQLITE),
    toStorageError,
    ready: async () => {
      await probe();
      await version();
    },
    ping: async () => {
      await probe();
      await read();
    },
    sent,
    boundParams: SQLITE_BOUND_PARAMS,
  });
}

/** The limiter the product owns on SQLite: the D1 limiter over the seam, kept in `ta_limit`. */
export function createSqliteLimiter(driver: SqliteDriver, clock?: Clock): LimiterPort {
  return createD1Limiter(driver.db, clock);
}
