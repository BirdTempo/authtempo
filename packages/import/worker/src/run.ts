import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { importUsers } from "../../src/import.js";
import { type ImportBundle, sourceOf } from "../../src/sources.js";
import type { ImportOptions, ImportReport } from "../../src/types.js";

/** What `tempo-auth-import ... --d1-bundle <file>` writes. */
export interface D1Bundle {
  bundle: ImportBundle;
  options: Omit<ImportOptions, "now">;
}

/**
 * The import into the D1 database of the binding `DB`, through core's D1
 * adapter. Async, so a bundle that `sourceOf` refuses gives a rejected
 * promise and not a throw at the call.
 */
export async function runImport(db: D1Database, input: D1Bundle): Promise<ImportReport> {
  return importUsers(createD1Adapter(db), sourceOf(input.bundle), input.options);
}
