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
  /** Null for an import; the result of `import verify` (spec 23 item 7). A shape only gains keys (spec 19 item 4). */
  verify: import("@authtempo/import").ImportVerify | null;
}
export const IMPORT_JSON_KEYS = {
  report: true,
  stopped: true,
  bundle: true,
  verify: true,
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
  /** The live TOTP setups with codes that the calls left, summed; a later pass moves them. */
  skipped: number;
  /** The `more` of the last call: true while a row under a configured old version remains. */
  more: boolean;
}
export const SECRET_REWRAP_JSON_KEYS = {
  calls: true,
  resealed: true,
  failed: true,
  skipped: true,
  more: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SecretRewrapJson, true>;

/** `authtempo info --json` (plan 11c2): a support report with no secret value and no host name. */
export interface InfoJson extends RunKeys {
  cli: string;
  schemaVersion: number;
  runtime: { node: string; platform: string; arch: string };
  /** The first word of npm_config_user_agent, else the packageManager field of the nearest package.json, else null. */
  packageManager: { name: string; version: string; source: "user-agent" | "package.json" } | null;
  /** Each @authtempo package of the nearest package.json, with its installed version or null. */
  packages: Record<string, string | null>;
  adapters: string[];
  /** The wrangler config beside the package.json, with each database_name and never a database_id. */
  project: { wrangler: boolean; d1Databases: string[] } | null;
  /** Each secret name of the templates, set or unset. Never a value. */
  env: Record<string, "set" | "unset">;
  /** The database of --target. compatVersion is read on Postgres only. */
  database: {
    kind: "postgres" | "d1";
    schemaVersion: number | null;
    applied: number;
    compatVersion: number | null;
  } | null;
  /** The answer of GET /operator/info, with each key path that is no plain name dropped and counted. */
  deployment: { core: string; schemaVersion: number; configKeys: string[]; dropped: number } | null;
  /** Each part that a flag asked for and that gave no answer, with its reason. */
  unread: { part: "database" | "deployment"; reason: string }[];
}
export const INFO_JSON_KEYS = {
  cli: true,
  schemaVersion: true,
  runtime: true,
  packageManager: true,
  packages: true,
  adapters: true,
  project: true,
  env: true,
  database: true,
  deployment: true,
  unread: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof InfoJson, true>;

/**
 * The document of a usage error or a thrown stop under `--json`, for each
 * command and each subcommand (plan 11e deviation 19). The key is the key
 * of `helpOf`. Each other key holds its empty value: "", [], null, false,
 * or a zero summary. `main` prints it with `stopped` set to the message.
 * `--version` has no stop, so the version has no entry.
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
  import: { report: null, stopped: null, bundle: null, verify: null, exit: 2 },
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
  "secret rewrap": {
    calls: 0,
    resealed: 0,
    failed: 0,
    skipped: 0,
    more: false,
    exit: 2,
    stopped: null,
  },
  info: {
    cli: "",
    schemaVersion: 0,
    runtime: { node: "", platform: "", arch: "" },
    packageManager: null,
    packages: {},
    adapters: [],
    project: null,
    env: {},
    database: null,
    deployment: null,
    unread: [],
    exit: 2,
    stopped: null,
  },
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
  info: InfoJson;
};
