import type { StorageAdapter } from "@tempo-auth/core";
import { createD1AdapterWith } from "./adapter.js";

/** Where wrangler finds this package's migrations: set `migrations_dir` to this path in wrangler.jsonc. */
export const D1_MIGRATIONS_DIR = "node_modules/@tempo-auth/adapter-d1/migrations";

export function createD1Adapter(db: D1Database): StorageAdapter {
  return createD1AdapterWith(db, async () => {});
}

export { toStorageError } from "./errors.js";
