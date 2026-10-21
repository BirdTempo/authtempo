import type { StorageAdapter } from "@authtempo/core";
import { coreStatements, SQLITE } from "@authtempo/core/sql";
import { createD1AdapterOn } from "./adapter.js";
import { toStorageError } from "./errors.js";
import { schemaVersionCheckOn, schemaVersionPing } from "./schema-version.js";
import type { D1Subset } from "./seam.js";

/** Where wrangler finds this package's migrations: set `migrations_dir` to this path in wrangler.jsonc. */
export const D1_MIGRATIONS_DIR = "node_modules/@authtempo/adapter-d1/migrations";

export function createD1Adapter(db: D1Database): StorageAdapter {
  // One count for the statements and the schema check (ruling 35 of plan 12f),
  // and the count of the check alone (`readyStatements`, ruling 37).
  const sent = { statements: 0, ready: 0 };
  return createD1AdapterOn(db, {
    statements: coreStatements(SQLITE),
    toStorageError,
    ready: schemaVersionCheckOn(db, sent),
    ping: schemaVersionPing(db, sent),
    sent,
  });
}

// The seam of plan 12g: a D1 binding is a D1Subset. A change of the
// binding's types fails the compile here.
const _check = (db: D1Database): D1Subset => db;

export { createD1AdapterOn, type D1AdapterOptions } from "./adapter.js";
export { toStorageError } from "./errors.js";
export { createD1Limiter } from "./limiter.js";
export { D1_SHAPE_SQL, d1ColumnType, expectedD1Shape, parseD1Shape } from "./shape.js";
