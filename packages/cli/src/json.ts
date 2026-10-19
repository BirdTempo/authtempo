import type { CheckReport } from "./checks.js";

/**
 * The JSON shape of each command's `--json` document (spec 19). A shape is
 * an interface for scripts: a change adds a key, and a removal goes through
 * a deprecation. Each key list ties the test of a document to its type.
 */

/**
 * The two keys of each shape but the version's (plan 11e deviation 19).
 * `exit` is the exit code of the run: 0, 1, or 2. `stopped` is the reason of
 * a stop or a usage error, or null. A script, and the MCP server, read the
 * result from these keys and never from stderr.
 */
export interface RunKeys {
  exit: number;
  stopped: string | null;
}
export interface VersionJson {
  cli: string;
  schemaVersion: number;
}
export const VERSION_JSON_KEYS = { cli: true, schemaVersion: true } as const satisfies Record<
  keyof VersionJson,
  true
>;

export interface KeysJson extends RunKeys {
  kid: string;
}
export const KEYS_JSON_KEYS = { kid: true, exit: true, stopped: true } as const satisfies Record<
  keyof KeysJson,
  true
>;

/**
 * `authtempo import --json`: the report of a run (the same JSON as
 * `--report <file>`), the reason of a stop, or the path of a D1 bundle.
 */
export interface ImportJson extends RunKeys {
  report: import("@authtempo/import").ImportReport | null;
  bundle: string | null;
}
export const IMPORT_JSON_KEYS = {
  report: true,
  stopped: true,
  bundle: true,
  exit: true,
} as const satisfies Record<keyof ImportJson, true>;

/** `authtempo migrate --json`: the run of one target. `pending` is what the database lacked before the run. */
export interface MigrateJson extends RunKeys {
  target: string;
  /** The empty string only in the document of a stop, which ran no target. */
  tables: "core" | "compat" | "";
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
  exit: true,
  stopped: true,
} as const satisfies Record<keyof MigrateJson, true>;

/** `authtempo init --json`: the stack, the folder, each file written, and the next steps. */
export interface InitJson extends RunKeys {
  stack: string;
  dir: string;
  files: string[];
  next: string[];
}
export const INIT_JSON_KEYS = {
  stack: true,
  dir: true,
  files: true,
  next: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof InitJson, true>;

/** `authtempo check --json`: the report of `runChecks`, with each check, the warnings, and the summary. */
export interface CheckJson extends CheckReport, RunKeys {}
export const CHECK_JSON_KEYS = {
  base: true,
  checks: true,
  warnings: true,
  summary: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof CheckJson, true>;

/**
 * `authtempo mcp --json`: the target, the file (null for --manual), what the
 * run did, and the entry. The entry is an object, or the TOML lines for
 * Codex. For --manual, it is the entry of each editor by its id.
 */
export interface McpJson extends RunKeys {
  editor: string;
  file: string | null;
  action: "written" | "unchanged" | "printed" | "stopped";
  entry: unknown;
}
export const MCP_JSON_KEYS = {
  editor: true,
  file: true,
  action: true,
  entry: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof McpJson, true>;

/** `authtempo secret --json` (plan 11c2). With --out the value is null: it is in the file only. */
export interface SecretJson extends RunKeys {
  kind: "app" | "operator";
  value: string | null;
  version: number | null;
  bytes: number;
  /** entropyBits(value) of core, rounded down. */
  estimateBits: number;
  out: string | null;
  /** --operator only: the SHA-256 hex for operator.secretHash. */
  secretHash: string | null;
}
export const SECRET_JSON_KEYS = {
  kind: true,
  value: true,
  version: true,
  bytes: true,
  estimateBits: true,
  out: true,
  secretHash: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SecretJson, true>;

/** `authtempo secret status --json` (plan 11c2): the counts of api.secrets.status(), with its key names. */
export interface SecretStatusJson extends RunKeys {
  versions: {
    version: number;
    configured: boolean;
    current: boolean;
    totpSecrets: number;
    backupCodes: number;
    signingKeys: number;
    emailCodes: number;
  }[];
}
export const SECRET_STATUS_JSON_KEYS = {
  versions: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SecretStatusJson, true>;

/** `authtempo secret rewrap --json` (plan 11c2): the sums of each call of the run. */
export interface SecretRewrapJson extends RunKeys {
  calls: number;
  resealed: number;
  failed: number;
  /** The `more` of the last call: true while a row under a configured old version remains. */
  more: boolean;
}
export const SECRET_REWRAP_JSON_KEYS = {
  calls: true,
  resealed: true,
  failed: true,
  more: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SecretRewrapJson, true>;

/**
 * The document of a usage error or a thrown stop under `--json`, for each
 * command and each subcommand, by the key of `helpOf` (plan 11e deviation 19). Each other key holds its empty value: "",
 * [], null, false, or a zero summary. `main` prints it with `stopped` set to
 * the message. `--version` has no stop, so the version has no entry.
 */
export const STOP_JSON = {
  init: { stack: "", dir: "", files: [], next: [], exit: 2, stopped: null },
  migrate: {
    target: "",
    tables: "",
    dryRun: false,
    before: null,
    after: null,
    pending: [],
    applied: [],
    copied: [],
    exit: 2,
    stopped: null,
  },
  import: { report: null, stopped: null, bundle: null, exit: 2 },
  check: {
    base: "",
    checks: [],
    warnings: [],
    summary: { run: 0, pass: 0, fail: 0, skip: 0 },
    exit: 2,
    stopped: null,
  },
  keys: { kid: "", exit: 2, stopped: null },
  mcp: { editor: "", file: null, action: "stopped", entry: null, exit: 2, stopped: null },
  secret: {
    kind: "app",
    value: null,
    version: null,
    bytes: 0,
    estimateBits: 0,
    out: null,
    secretHash: null,
    exit: 2,
    stopped: null,
  },
  "secret status": { versions: [], exit: 2, stopped: null },
  "secret rewrap": { calls: 0, resealed: 0, failed: 0, more: false, exit: 2, stopped: null },
} satisfies {
  init: InitJson;
  migrate: MigrateJson;
  import: ImportJson;
  check: CheckJson;
  keys: KeysJson;
  mcp: McpJson;
  secret: SecretJson;
  "secret status": SecretStatusJson;
  "secret rewrap": SecretRewrapJson;
};
