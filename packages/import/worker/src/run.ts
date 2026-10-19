import { createD1Adapter } from "@authtempo/adapter-d1";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import type { StorageAdapter } from "@authtempo/core";
import {
  bundleOf,
  type ImportBundle,
  type ImportOptions,
  type ImportReport,
  importUsers,
  optionsOf,
  readSource,
} from "@authtempo/import";

/** What `authtempo import ... --target d1-bundle --out <file>` writes (and the alias's `--d1-bundle <file>`). */
export interface D1Bundle {
  bundle: ImportBundle;
  options: Omit<ImportOptions, "now">;
  /**
   * A verify bundle, from `authtempo import verify --target d1-bundle`: the
   * Worker prints `verifyReport` beside the report (spec 23 item 7). Its
   * options hold `dryRun: true`, so the run reads only.
   */
  verify?: true;
}

/**
 * The tables the import writes (plan 9b2): `core` writes core's tables through
 * core's D1 adapter; `compat` writes an app's Better Auth 1.7 tables through
 * the compatibility package's storage, the mapping that its `betterAuth`
 * serves.
 */
export type ImportTarget = "core" | "compat";

/**
 * The `TARGET` var: `core` (the default of worker/wrangler.jsonc, also when
 * the var is absent) or `compat`. Any other value refuses before any read, so
 * a typo never writes the wrong tables.
 */
export function targetOf(value: string | undefined): ImportTarget {
  if (value === undefined || value === "core") return "core";
  if (value === "compat") return "compat";
  throw new Error(
    `authtempo import: TARGET is core or compat, not ${JSON.stringify(value)}; nothing was written`,
  );
}

/**
 * The storage of a target. `compat` is `betterAuthSchemaStorage`, which is
 * `createD1AdapterOn` with the compatibility package's statements. Its ready
 * check (the compat migrations and the unique key on account (issuer,
 * accountId)) runs before the first read, so a database without the compat
 * migrations refuses with schema_mismatch before any write.
 */
export function storageFor(db: D1Database, target: ImportTarget): StorageAdapter {
  return target === "compat"
    ? betterAuthSchemaStorage({ dialect: "d1", db }).storage
    : createD1Adapter(db);
}

/**
 * Checks the Worker's input: the bundle through `bundleOf`, and every option
 * value by type through `optionsOf`. A truthy string such as
 * `"legacyVerify": "false"` would import Cognito markers, so no option is
 * passed on unchecked.
 */
export function d1BundleOf(value: unknown): D1Bundle {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("authtempo import: the D1 input field (root) is not an object");
  const { bundle, options } = value as Record<string, unknown>;
  const verify = isVerifyInput(value);
  const checked = optionsOf(options);
  // A verify reads only. A bundle that says verify and not dryRun would write
  // the records and then report that the database did not hold them.
  if (verify && checked.dryRun !== true)
    throw new Error(
      "authtempo import: the D1 input field verify needs options.dryRun true; nothing was written",
    );
  return { bundle: bundleOf(bundle), options: checked, ...(verify ? { verify: true } : {}) };
}

/**
 * True for a verify bundle. An absent field is a plain import. Any value
 * other than true or false refuses before any read, as each option does.
 */
export function isVerifyInput(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const { verify } = input as Record<string, unknown>;
  if (verify === undefined) return false;
  if (typeof verify !== "boolean")
    throw new Error(
      "authtempo import: the D1 input field verify is not true or false; nothing was written",
    );
  return verify;
}

/**
 * The import into the D1 database of the binding `DB`, in the tables of the
 * target. It checks the input, then reads every record (`readSource`, as the
 * CLI does) before the first write, so a malformed file writes nothing.
 */
export async function runImport(
  db: D1Database,
  input: unknown,
  target: ImportTarget = "core",
): Promise<ImportReport> {
  const { bundle, options } = d1BundleOf(input);
  const source = await readSource(bundle);
  return importUsers(storageFor(db, target), source, options);
}
