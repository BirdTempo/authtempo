import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { importUsers } from "../../src/import.js";
import { bundleOf, type ImportBundle, readSource } from "../../src/sources.js";
import type { ImportOptions, ImportReport } from "../../src/types.js";

/** What `tempo-auth-import ... --d1-bundle <file>` writes. */
export interface D1Bundle {
  bundle: ImportBundle;
  options: Omit<ImportOptions, "now">;
}

/**
 * Checks the Worker's input: the bundle through `bundleOf`, and the options
 * as an object. The importer checks each option value. `dryRun` is checked
 * here too, because a dry run that reads as a real run writes.
 */
export function d1BundleOf(value: unknown): D1Bundle {
  const bad = (field: string, problem: string): never => {
    throw new Error(`tempo-auth import: the D1 input field ${field} ${problem}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad("(root)", "is not an object");
  const { bundle, options } = value as Record<string, unknown>;
  if (typeof options !== "object" || options === null || Array.isArray(options))
    return bad("options", "is not an object");
  const dryRun = (options as Record<string, unknown>).dryRun;
  if (dryRun !== undefined && typeof dryRun !== "boolean")
    bad("options.dryRun", "is not true or false");
  return { bundle: bundleOf(bundle), options: options as D1Bundle["options"] };
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
