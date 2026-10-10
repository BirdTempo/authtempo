import type { StorageAdapter } from "@tempo-auth/core";
import { coreStatements, SQLITE } from "@tempo-auth/core/sql";
import { createD1AdapterOn } from "./adapter.js";
import { toStorageError } from "./errors.js";
import { schemaVersionCheck } from "./schema-version.js";

/** Where wrangler finds this package's migrations: set `migrations_dir` to this path in wrangler.jsonc. */
export const D1_MIGRATIONS_DIR = "node_modules/@tempo-auth/adapter-d1/migrations";

export function createD1Adapter(db: D1Database): StorageAdapter {
  return createD1AdapterOn(db, {
    statements: coreStatements(SQLITE),
    toStorageError,
    ready: schemaVersionCheck(db),
  });
}

export { createD1AdapterOn, type D1AdapterOptions } from "./adapter.js";
export { toStorageError } from "./errors.js";
export { createD1Limiter } from "./limiter.js";
