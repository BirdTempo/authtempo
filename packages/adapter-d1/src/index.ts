import type { StorageAdapter } from "@authtempo/core";
import { coreStatements, SQLITE } from "@authtempo/core/sql";
import { createD1AdapterOn } from "./adapter.js";
import { toStorageError } from "./errors.js";
import { schemaVersionCheck } from "./schema-version.js";

/** Where wrangler finds this package's migrations: set `migrations_dir` to this path in wrangler.jsonc. */
export const D1_MIGRATIONS_DIR = "node_modules/@authtempo/adapter-d1/migrations";

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
export { D1_SHAPE_SQL, d1ColumnType, expectedD1Shape, parseD1Shape } from "./shape.js";
