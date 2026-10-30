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
  /** --operator only: the SHA-256 hex for the secretHash of an entry of operator.secrets. */
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
    ssoClientSecrets: number;
    stateData: number;
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
 * `authtempo generate --json` (plan 12g): the schema text of one format and
 * one dialect. `text` holds the text when the run prints it, and null when
 * `out` names the file that holds it.
 */
export interface GenerateJson extends RunKeys {
  format: string;
  dialect: string;
  schemaVersion: number;
  out: string | null;
  text: string | null;
}
export const GENERATE_JSON_KEYS = {
  format: true,
  dialect: true,
  schemaVersion: true,
  out: true,
  text: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof GenerateJson, true>;

/**
 * The document of a command that has subcommands only (plan 12f): `users`,
 * `sessions`, and `audit` with no subcommand. Such a run is a usage error,
 * so its document holds the two run keys only.
 */
export type GroupJson = RunKeys;
export const GROUP_JSON_KEYS = { exit: true, stopped: true } as const satisfies Record<
  keyof GroupJson,
  true
>;

/**
 * One user as the operator routes answer it (spec 26 item 4): no hash, no
 * sealed value, no token, and no provider subject. The CLI copies these
 * keys only.
 */
export interface OperatorUserJson {
  id: string;
  /** Null for a user with no address (plan 12i Task 1). */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  createdAt: string;
  ban: { at: string; reason: string | null; until: string | null } | null;
  platformOperator: boolean;
  secondFactor: string[];
  /** The live sessions, counted up to 100. */
  sessions: number;
  identities: string[];
}

/** `authtempo users list --json` and `users search --json` (plan 12f): the users, and the cursor of the next page. */
export interface UsersListJson extends RunKeys {
  users: OperatorUserJson[];
  /** Null after the last page, and after a run with --all. */
  next: string | null;
}
export const USERS_LIST_JSON_KEYS = {
  users: true,
  next: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof UsersListJson, true>;

/** `authtempo users get --json` (plan 12f). The user is null only in the document of a stop. */
export interface UserJson extends RunKeys {
  user: OperatorUserJson | null;
}
export const USER_JSON_KEYS = { user: true, exit: true, stopped: true } as const satisfies Record<
  keyof UserJson,
  true
>;

/** `authtempo users ban|unban|platform-role|second-factor-off --json` (plan 12f): the id of the audit row of the act. */
export interface OperatorWriteJson extends RunKeys {
  auditId: string;
}
export const OPERATOR_WRITE_JSON_KEYS = {
  auditId: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof OperatorWriteJson, true>;

/**
 * `authtempo users create --json` (plan 12f2): the id of the new user, what
 * the deployment mailed to the person, and the audit row of the act. It
 * holds no address, no phone number, no token, and no link. The user id is
 * "" only in the document of a stop.
 */
export interface UserCreateJson extends RunKeys {
  userId: string;
  mailed: "invite" | "reset" | null;
  auditId: string;
}
export const USER_CREATE_JSON_KEYS = {
  userId: true,
  mailed: true,
  auditId: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof UserCreateJson, true>;

/**
 * `authtempo users update --json` (plan 12f2): the user after the change,
 * and the audit row of the act. The user is null only in the document of a stop.
 */
export interface UserUpdateJson extends RunKeys {
  user: OperatorUserJson | null;
  auditId: string;
}
export const USER_UPDATE_JSON_KEYS = {
  user: true,
  auditId: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof UserUpdateJson, true>;

/**
 * `authtempo users delete --json` (plan 12f2): the ids of the organizations
 * that went with the account, and the audit row of the act.
 */
export interface UserDeleteJson extends RunKeys {
  organizations: string[];
  auditId: string;
}
export const USER_DELETE_JSON_KEYS = {
  organizations: true,
  auditId: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof UserDeleteJson, true>;

/** `authtempo sessions end --json` (plan 12f): the sums of the calls, and the audit row of each call. */
export interface SessionsEndJson extends RunKeys {
  ended: number;
  calls: number;
  /** The `more` of the last call: true while a session of the user is left. */
  more: boolean;
  auditIds: string[];
}
export const SESSIONS_END_JSON_KEYS = {
  ended: true,
  calls: true,
  more: true,
  auditIds: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SessionsEndJson, true>;

/** `authtempo sessions end-all --json` (plan 12f): the sums of the calls. */
export interface SessionsEndAllJson extends RunKeys {
  ended: number;
  calls: number;
  /** The `more` of the last call: true while a session is left. */
  more: boolean;
}
export const SESSIONS_END_ALL_JSON_KEYS = {
  ended: true,
  calls: true,
  more: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof SessionsEndAllJson, true>;

/** One audit row as `GET /operator/audit` answers it (spec 26 item 8). `actorId` names a secret by its name. */
export interface AuditRowJson {
  id: string;
  createdAt: string;
  updatedAt: string;
  actorKind: string;
  actorId: string;
  action: string;
  targetUserId: string | null;
  reason: string;
  data: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** `authtempo audit list --json` (plan 12f): the rows, and the cursor of the next page. */
export interface AuditListJson extends RunKeys {
  rows: AuditRowJson[];
  next: string | null;
}
export const AUDIT_LIST_JSON_KEYS = {
  rows: true,
  next: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof AuditListJson, true>;

/** `authtempo create-admin --json` (plan 12f): the user, whether the run made it, and the audit row. */
export interface CreateAdminJson extends RunKeys {
  userId: string;
  created: boolean;
  auditId: string;
}
export const CREATE_ADMIN_JSON_KEYS = {
  userId: true,
  created: true,
  auditId: true,
  exit: true,
  stopped: true,
} as const satisfies Record<keyof CreateAdminJson, true>;

/**
 * `authtempo upgrade --json` (plan 12j Task 10, spec 33 item 10.8): the
 * installed version and the target, each package entry that moved, the
 * schema versions of core, each crossed minor with its "Breaking:" lines,
 * and each deprecation whose removal falls in the range. `from` and `to`
 * are null only in the document of a stop.
 */
export interface UpgradeJson extends RunKeys {
  exit: 0 | 1 | 2;
  from: string | null;
  to: string | null;
  /** One row per entry of package.json, by its key: the alias keeps the key `better-auth`. */
  packages: { name: string; from: string; to: string }[];
  /** Null when the app is current, or when a core manifest names no schema version. */
  schema: { from: number; to: number; migrate: boolean } | null;
  breaking: { minor: string; lines: string[] }[];
  deprecations: { id: string; removeIn: string; docs: string }[];
}
export const UPGRADE_JSON_KEYS = {
  exit: true,
  stopped: true,
  from: true,
  to: true,
  packages: true,
  schema: true,
  breaking: true,
  deprecations: true,
} as const satisfies Record<keyof UpgradeJson, true>;

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
  users: { exit: 2, stopped: null },
  "users list": { users: [], next: null, exit: 2, stopped: null },
  "users search": { users: [], next: null, exit: 2, stopped: null },
  "users get": { user: null, exit: 2, stopped: null },
  "users ban": { auditId: "", exit: 2, stopped: null },
  "users unban": { auditId: "", exit: 2, stopped: null },
  "users platform-role": { auditId: "", exit: 2, stopped: null },
  "users second-factor-off": { auditId: "", exit: 2, stopped: null },
  "users create": { userId: "", mailed: null, auditId: "", exit: 2, stopped: null },
  "users update": { user: null, auditId: "", exit: 2, stopped: null },
  "users delete": { organizations: [], auditId: "", exit: 2, stopped: null },
  sessions: { exit: 2, stopped: null },
  "sessions end": { ended: 0, calls: 0, more: false, auditIds: [], exit: 2, stopped: null },
  "sessions end-all": { ended: 0, calls: 0, more: false, exit: 2, stopped: null },
  audit: { exit: 2, stopped: null },
  "audit list": { rows: [], next: null, exit: 2, stopped: null },
  "create-admin": { userId: "", created: false, auditId: "", exit: 2, stopped: null },
  generate: {
    format: "",
    dialect: "",
    schemaVersion: 0,
    out: null,
    text: null,
    exit: 2,
    stopped: null,
  },
  upgrade: {
    exit: 2,
    stopped: null,
    from: null,
    to: null,
    packages: [],
    schema: null,
    breaking: [],
    deprecations: [],
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
  users: GroupJson;
  "users list": UsersListJson;
  "users search": UsersListJson;
  "users get": UserJson;
  "users ban": OperatorWriteJson;
  "users unban": OperatorWriteJson;
  "users platform-role": OperatorWriteJson;
  "users second-factor-off": OperatorWriteJson;
  "users create": UserCreateJson;
  "users update": UserUpdateJson;
  "users delete": UserDeleteJson;
  sessions: GroupJson;
  "sessions end": SessionsEndJson;
  "sessions end-all": SessionsEndAllJson;
  audit: GroupJson;
  "audit list": AuditListJson;
  "create-admin": CreateAdminJson;
  generate: GenerateJson;
  upgrade: UpgradeJson;
};
