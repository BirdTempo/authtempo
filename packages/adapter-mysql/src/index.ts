import type { StorageAdapter } from "@authtempo/core";
import { coreStatements, MYSQL } from "@authtempo/core/sql";
import type { Pool } from "mysql2/promise";
import { createMysqlAdapterOn } from "./adapter.js";
import { toStorageError } from "./errors.js";
import { mysqlSchemaVersionPing, mysqlStartChecks, type Sent } from "./start-checks.js";

/**
 * The storage adapter on MySQL 8.4 and later through a mysql2 pool. The app
 * opens the pool. The adapter runs its four checks at start on the first
 * call (see README "Checks at start"). Its `ping` reads the schema version
 * with no cache, each call.
 */
export function createMysqlAdapter(pool: Pool): StorageAdapter {
  const sent: Sent = { statements: 0, ready: 0 };
  return createMysqlAdapterOn(pool, {
    statements: coreStatements(MYSQL),
    toStorageError,
    ready: mysqlStartChecks(pool, sent),
    ping: mysqlSchemaVersionPing(pool, sent),
    sent,
  });
}

export { createMysqlAdapterOn, type MysqlAdapterOptions } from "./adapter.js";
export { toStorageError } from "./errors.js";
export { createMysqlLimiter } from "./limiter.js";
export {
  applyMysqlMigrations,
  MIGRATIONS_TABLE_SQL as MYSQL_MIGRATIONS_TABLE_SQL,
  MYSQL_MIGRATIONS,
  type MysqlMigration,
} from "./migrations.js";
export { expectedMysqlShape, readMysqlShape } from "./shape.js";
export { mysqlSchemaVersionPing, mysqlStartChecks } from "./start-checks.js";
