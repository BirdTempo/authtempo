/**
 * The JSON shape of each command's `--json` document (spec 19). A shape is
 * an interface for scripts: a change adds a key, and a removal goes through
 * a deprecation. Each key list ties the test of a document to its type.
 */
export interface VersionJson {
  cli: string;
  schemaVersion: number;
}
export const VERSION_JSON_KEYS = { cli: true, schemaVersion: true } as const satisfies Record<
  keyof VersionJson,
  true
>;

export interface KeysJson {
  kid: string;
}
export const KEYS_JSON_KEYS = { kid: true } as const satisfies Record<keyof KeysJson, true>;

/**
 * `authtempo import --json`: the report of a run (the same JSON as
 * `--report <file>`), the reason of a stop, or the path of a D1 bundle.
 */
export interface ImportJson {
  report: import("@authtempo/import").ImportReport | null;
  stopped: string | null;
  bundle: string | null;
}
export const IMPORT_JSON_KEYS = {
  report: true,
  stopped: true,
  bundle: true,
} as const satisfies Record<keyof ImportJson, true>;

/** `authtempo migrate --json`: the run of one target. `pending` is what the database lacked before the run. */
export interface MigrateJson {
  target: string;
  tables: "core" | "compat";
  dryRun: boolean;
  before: number | null;
  after: number | null;
  pending: string[];
  applied: string[];
  copied: string[];
}
export const MIGRATE_JSON_KEYS = {
  target: true,
  tables: true,
  dryRun: true,
  before: true,
  after: true,
  pending: true,
  applied: true,
  copied: true,
} as const satisfies Record<keyof MigrateJson, true>;
