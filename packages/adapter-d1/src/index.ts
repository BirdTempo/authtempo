import type { StorageAdapter } from "@tempo-auth/core";
import { createD1AdapterWith } from "./adapter.js";
import { schemaVersionCheck } from "./schema-version.js";

/** Where wrangler finds this package's migrations: set `migrations_dir` to this path in wrangler.jsonc. */
export const D1_MIGRATIONS_DIR = "node_modules/@tempo-auth/adapter-d1/migrations";

export function createD1Adapter(db: D1Database): StorageAdapter {
  return createD1AdapterWith(db, schemaVersionCheck(db));
}

export { toStorageError } from "./errors.js";
export { createD1Limiter } from "./limiter.js";
