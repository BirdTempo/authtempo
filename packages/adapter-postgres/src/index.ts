import type { StorageAdapter } from "@authtempo/core";
import { coreStatements, POSTGRES } from "@authtempo/core/sql";
import type { Sql } from "postgres";
import { createPostgresAdapterOn } from "./adapter.js";
import { toStorageError } from "./errors.js";
import { schemaVersionCheck } from "./schema-version.js";

export function createPostgresAdapter(sql: Sql): StorageAdapter {
  return createPostgresAdapterOn(sql, {
    statements: coreStatements(POSTGRES),
    toStorageError,
    ready: schemaVersionCheck(sql),
  });
}

export { createPostgresAdapterOn, type PostgresAdapterOptions } from "./adapter.js";
export { type CoreFieldType, postgresColumnType } from "./column-types.js";
export { toStorageError } from "./errors.js";
export { createPostgresLimiter } from "./limiter.js";
export {
  applyPostgresMigrations,
  MIGRATIONS,
  type Migration,
  migrationLockSql,
} from "./migrations.js";
export { expectedPostgresShape, readPostgresShape } from "./shape.js";
