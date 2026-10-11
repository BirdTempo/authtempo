import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { importUsers } from "../../src/import.js";
import { bundleOf, type ImportBundle, optionsOf, readSource } from "../../src/sources.js";
import type { ImportOptions, ImportReport } from "../../src/types.js";

/** What `tempo-auth-import ... --d1-bundle <file>` writes. */
export interface D1Bundle {
  bundle: ImportBundle;
  options: Omit<ImportOptions, "now">;
}

/**
 * Checks the Worker's input: the bundle through `bundleOf`, and every option
 * value by type through `optionsOf`. A truthy string such as
 * `"legacyVerify": "false"` would import Cognito markers, so no option is
 * passed on unchecked.
 */
export function d1BundleOf(value: unknown): D1Bundle {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("tempo-auth import: the D1 input field (root) is not an object");
  const { bundle, options } = value as Record<string, unknown>;
  return { bundle: bundleOf(bundle), options: optionsOf(options) };
}

/**
 * The import into the D1 database of the binding `DB`, through core's D1
 * adapter. It checks the input, then reads every record (`readSource`, as
 * the CLI does) before the first write, so a malformed file writes nothing.
 */
export async function runImport(db: D1Database, input: unknown): Promise<ImportReport> {
  const { bundle, options } = d1BundleOf(input);
  const source = await readSource(bundle);
  return importUsers(createD1Adapter(db), source, options);
}
