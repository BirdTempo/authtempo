import type { StorageAdapter } from "@authtempo/core";
import { coreStatements, POSTGRES } from "@authtempo/core/sql";
import { createPostgresAdapterOn } from "./adapter.js";
import type { PostgresClient } from "./client.js";
import { toStorageError } from "./errors.js";
import { schemaVersionCheck, schemaVersionPing } from "./schema-version.js";

export function createPostgresAdapter(sql: PostgresClient): StorageAdapter {
  return createPostgresAdapterOn(sql, {
    statements: coreStatements(POSTGRES),
    toStorageError,
    ready: schemaVersionCheck(sql),
    ping: schemaVersionPing(sql),
  });
}

export { createPostgresAdapterOn, type PostgresAdapterOptions } from "./adapter.js";
export type {
  PostgresClient,
  PostgresConnection,
  PostgresParameter,
  PostgresRows,
  PostgresTransaction,
} from "./client.js";
export { type CoreFieldType, postgresColumnType } from "./column-types.js";
export { toStorageError } from "./errors.js";
export { createPostgresLimiter } from "./limiter.js";
export {
  applyPostgresMigrations,
  MIGRATIONS,
  MIGRATIONS_TABLE_SQL,
  type Migration,
} from "./migrations.js";
export { expectedPostgresShape, readPostgresShape } from "./shape.js";
