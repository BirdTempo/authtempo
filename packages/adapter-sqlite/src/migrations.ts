import type { SqliteDriver } from "./adapter.js";
import { D1_FILES } from "./migrations.generated.js";

/** The SQLite migrations: the D1 files, copied at build into one module (plan 12g). */
export const SQLITE_MIGRATIONS: readonly { name: string; sql: string }[] = D1_FILES;

const CREATE =
  "CREATE TABLE IF NOT EXISTS ta_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)";
const DONE = "SELECT 1 FROM ta_migrations WHERE name = ?";
const RECORD = "INSERT INTO ta_migrations (name, applied_at) VALUES (?, ?)";

/**
 * Runs each migration of `list` that `ta_migrations` does not hold, in list
 * order, and answers the names that ran. Each migration and its record run
 * in one BEGIN IMMEDIATE transaction, so a second process waits for the write
 * lock and then skips the work. No transaction spans an await on a
 * synchronous driver.
 */
export async function runSqliteMigrations(
  driver: SqliteDriver,
  list: readonly { name: string; sql: string }[],
): Promise<string[]> {
  await driver.db.prepare(CREATE).run();
  const ran: string[] = [];
  for (const m of list) {
    const done = { sql: DONE, params: [m.name] };
    const record = { sql: RECORD, params: [m.name, Date.now()] };
    if (await driver.migrateStep(done, m.sql, record)) ran.push(m.name);
  }
  return ran;
}

/** Brings the database to the schema of this package. Safe on every start. */
export function applySqliteMigrations(driver: SqliteDriver): Promise<string[]> {
  return runSqliteMigrations(driver, SQLITE_MIGRATIONS);
}
