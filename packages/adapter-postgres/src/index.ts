import type { StorageAdapter } from "@tempo-auth/core";
import type { Sql } from "postgres";
import { createPostgresAdapterWith } from "./adapter.js";
import { schemaVersionCheck } from "./schema-version.js";

export function createPostgresAdapter(sql: Sql): StorageAdapter {
  return createPostgresAdapterWith(sql, schemaVersionCheck(sql));
}

export { toStorageError } from "./errors.js";
export { applyPostgresMigrations, MIGRATIONS, type Migration } from "./migrations.js";
