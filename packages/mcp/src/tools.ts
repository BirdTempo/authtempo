import { z } from "zod";
import { PAGE_TYPES } from "./index-format.js";
import type { Surface } from "./spec.js";

/**
 * One row of the tool table. The table is pure data (zod schemas, no CLI
 * import), so the remote Worker can hold it. A row that wraps a CLI command
 * names the command and its flags; a docs tool wraps none.
 */
export interface ToolRow {
  name: string;
  title: string;
  /** The first sentence states the effect of the tool: what it reads and what it writes. */
  description: string;
  surfaces: readonly Surface[];
  wraps: {
    command: string;
    positional: readonly string[];
    flags: Readonly<Record<string, string>>;
    /** The flags that the handler always passes, such as --json or --target postgres. */
    fixed: readonly string[];
    toolOnly: readonly string[];
  } | null;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /** A strict object: an input key that the row does not name is an input error. */
  input: z.ZodObject;
  outputKeys: readonly string[];
}

/** The docs tools read the index that the server loaded at its start, and nothing else. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** The docs version: "latest" until a release exists (spec 18 item 13). */
const docsVersion = z
  .string()
  .min(1)
  .max(40)
  .default("latest")
  .describe('The docs version. One of header.versions of the index; "latest" by default.');

/**
 * The stacks of `authtempo init`. The Worker cannot import the CLI, so the
 * list is a copy of STACKS of @authtempo/cli/program; scaffold.test.ts holds the two equal.
 */
export const SCAFFOLD_STACKS = [
  "workers-d1",
  "workers-postgres",
  "node",
  "bun",
  "mcp-server",
] as const;

/**
 * The keys of `authtempo init --json` (INIT_JSON_KEYS of the CLI): the
 * document of a run, with its exit code and the reason of a stop.
 */
const INIT_KEYS = ["stack", "dir", "files", "next", "exit", "stopped"] as const;

/**
 * The providers of `authtempo import`. The Worker cannot import the CLI, so
 * the list is a copy of PROVIDERS of @authtempo/cli/program; migrate.test.ts
 * holds the two equal.
 */
export const IMPORT_PROVIDERS = [
  "supabase",
  "clerk",
  "auth0",
  "firebase",
  "authjs",
  "cognito",
] as const;

/**
 * The keys of `authtempo import --json` (IMPORT_JSON_KEYS of the CLI): the
 * report, the reason of a stop, the bundle path, and the exit code.
 */
const IMPORT_KEYS = ["report", "stopped", "bundle", "exit"] as const;

/**
 * The keys of `authtempo migrate --json` (MIGRATE_JSON_KEYS of the CLI): the
 * target, the table set, the versions, the migration names, and the exit code.
 */
const MIGRATE_KEYS = [
  "target",
  "tables",
  "dryRun",
  "before",
  "after",
  "pending",
  "applied",
  "copied",
  "exit",
  "stopped",
] as const;

/**
 * The keys of `authtempo check --json` (CHECK_JSON_KEYS of the CLI). The
 * check tool keeps these keys, and drops each text of the deployment
 * (plan deviation 1). check.test.ts holds the two lists equal.
 */
const CHECK_KEYS = ["base", "checks", "warnings", "summary", "exit", "stopped"] as const;

/**
 * True for an http or https origin: the rule of baseOf of the CLI. A path, a
 * query, a fragment, or credentials fail here, before the CLI runs. The CLI's
 * usage error repeats the input, so a password would reach the stop text.
 */
const httpOrigin = (value: string): boolean => {
  try {
    const u = new URL(value);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.pathname === "/" &&
      u.search === "" &&
      u.hash === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
};

/** The name of an environment variable: the CLI's rule (ENV_NAME of packages/cli/src/secrets.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The file inputs of an import, in the CLI's order. The row builds its
 * file keys from this list, and the handler hashes each key of it. So a new
 * file key is in the plan's digests, and migrate.run binds it.
 */
export const IMPORT_FILE_INPUTS = [
  "users",
  "identities",
  "csv",
  "hashes",
  "organizations",
  "authjs_tables",
] as const;

/** What each file input holds, for its description. */
const FILE_WHAT: Record<(typeof IMPORT_FILE_INPUTS)[number], string> = {
  users: "the users export",
  identities: "the identities export (Supabase)",
  csv: "the CSV export (Clerk)",
  hashes: "the password hash export (Auth0)",
  organizations: "the organizations export (Clerk, Auth0)",
  authjs_tables: "the Auth.js tables export",
};

/**
 * A relative path of an export file inside the server root. A dash at the
 * start would read as a flag of the CLI.
 */
const exportFile = (what: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^-]/)
    .optional()
    .describe(`A relative path inside the server root: ${what}.`);

/**
 * The input of migrate.plan without `against`, and of migrate.run without
 * plan_id and confirm. Each key maps to the import flag of the same name,
 * with "_" as "-". No key takes a connection string: the CLI reads it from
 * the server's environment, through the variable that --url-env names.
 * No key passes --repair: a repair writes into users that exist, and the
 * help says to check each such user in the app first. That stays a shell step.
 */
const IMPORT_INPUT = {
  provider: z.enum(IMPORT_PROVIDERS).describe("The provider of the export."),
  ...(Object.fromEntries(IMPORT_FILE_INPUTS.map((k) => [k, exportFile(FILE_WHAT[k])])) as Record<
    (typeof IMPORT_FILE_INPUTS)[number],
    ReturnType<typeof exportFile>
  >),
  formats: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "The formats list of the app's createLegacyPasswordHash, comma-separated, or none. Each provider but Cognito needs it.",
    ),
  role_map: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Source role to owner, admin, or member, such as org:admin=admin,basic=member."),
  reserved_slugs: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("The reserved organization slugs, comma-separated."),
  platform_slug: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("The slug of the platform organization."),
  on_email_taken: z
    .enum(["skip", "fail"])
    .optional()
    .describe("What a taken address does: skip the record (the default), or stop the run."),
  password_column: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("The column of the Auth.js users table that holds the password hash."),
  same_passkey_rp_id: z
    .boolean()
    .optional()
    .describe("True when the app keeps the passkey rp id of the Auth.js app."),
  legacy_verify: z
    .boolean()
    .optional()
    .describe("True when the app sets password.legacyVerify. A Cognito import needs it."),
  firebase_signer_key_env: z
    .string()
    .min(1)
    .max(100)
    .regex(ENV_NAME)
    .optional()
    .describe("The name of the variable that holds the Firebase signer key, never the key."),
  firebase_salt_separator: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The salt separator of the Firebase project."),
  firebase_rounds: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("The rounds of the Firebase project."),
  firebase_mem_cost: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("The mem cost of the Firebase project."),
  tables: z
    .enum(["core", "compat"])
    .default("core")
    .describe("The table set: core, or compat for a Better Auth schema."),
};

/** The import flag of each input key: "_" becomes "-". */
const IMPORT_FLAGS = Object.fromEntries(
  Object.keys(IMPORT_INPUT)
    .filter((k) => k !== "provider")
    .map((k) => [k, k.replaceAll("_", "-")]),
);

export const TOOLS: readonly ToolRow[] = [
  {
    name: "docs.search",
    title: "Search the authtempo docs",
    description:
      "Reads no file and writes nothing. Searches the sections of the authtempo docs and answers the best sections, each with its page path, its anchor, and a short snippet.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({
      query: z.string().min(2).max(200).describe("The words to search for."),
      limit: z.number().int().min(1).max(10).default(5).describe("The most hits to answer."),
      type: z.enum(PAGE_TYPES).optional().describe("Only the pages of this type."),
      version: docsVersion,
    }),
    outputKeys: ["version", "results"],
  },
  {
    name: "docs.read",
    title: "Read an authtempo docs page",
    description:
      "Reads no file and writes nothing. Answers the agent markdown of one docs page, or of one section of it. With no path, it answers the index of every page.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({
      // Any text. The handler adds a final slash and drops the site origin. A
      // path that is still unknown gets the nearest paths, not a schema error.
      path: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("A page path such as /docs/guides/magic-link/. With no path, the index."),
      section: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The anchor of one section of the page, such as steps."),
      version: docsVersion,
    }),
    outputKeys: ["version", "path", "title", "description", "type", "sources", "markdown", "links"],
  },
  {
    name: "version",
    title: "The versions of authtempo and of the docs index",
    description:
      "Reads no file and writes nothing. Answers the versions of @authtempo/core, the CLI, and this server, the schema version, the protocol revision, and the facts of the docs index.",
    surfaces: ["local", "remote"],
    wraps: null,
    annotations: READ_ONLY,
    input: z.strictObject({}),
    outputKeys: ["core", "cli", "mcp", "schemaVersion", "protocol", "docsIndex"],
  },
  {
    name: "scaffold",
    title: "Write a new authtempo app",
    description:
      "Writes the files of a new app into dir, inside the server root, and overwrites no file. It runs authtempo init with the stack, and answers each file it wrote and the next steps. It runs no install.",
    surfaces: ["local"],
    wraps: {
      command: "init",
      positional: ["dir"],
      flags: { stack: "stack" },
      fixed: ["--json"],
      toolOnly: [],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({
      // A dash at the start would read as a flag of the CLI, such as --help.
      dir: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^-]/)
        .describe("A relative path of a new folder inside the server root, such as apps/web."),
      stack: z.enum(SCAFFOLD_STACKS).describe("The stack of the app."),
    }),
    outputKeys: INIT_KEYS,
  },
  {
    name: "migrate.plan",
    title: "Plan an import of users from another provider",
    description:
      'Plans an import and writes nothing. It reads the export files inside the server root and runs authtempo import with --dry-run. With against "empty" it plans against an empty store. With against "database" it plans against the database that the server\'s environment names, and answers a plan_id for migrate.run. It answers the report and the shell command of the real run.',
    surfaces: ["local"],
    wraps: {
      command: "import",
      positional: ["provider"],
      flags: IMPORT_FLAGS,
      // The target flags follow `against`: --target memory, or --target postgres --url-env <NAME>.
      fixed: ["--dry-run", "--json"],
      toolOnly: ["against"],
    },
    annotations: READ_ONLY,
    input: z.strictObject({
      ...IMPORT_INPUT,
      against: z
        .enum(["empty", "database"])
        .default("empty")
        .describe(
          'Plan against an empty store ("empty", no database) or against the database ("database"). Only a plan against the database gives a plan_id.',
        ),
    }),
    outputKeys: [...IMPORT_KEYS, "against", "plan_id", "next"],
  },
  {
    name: "migrate.run",
    title: "Run a held import plan",
    description:
      "Writes the users of a held plan into the database that the server's environment names. It takes the plan_id of a migrate.plan against the database, with the same input and the same files, once, within 10 minutes. It runs authtempo import with --target postgres.",
    surfaces: ["local"],
    wraps: {
      command: "import",
      positional: ["provider"],
      flags: IMPORT_FLAGS,
      // --url-env <NAME> follows: the server's --url-env, never a tool input.
      fixed: ["--target", "postgres", "--json"],
      toolOnly: ["plan_id", "confirm"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({
      ...IMPORT_INPUT,
      plan_id: z
        .string()
        .min(1)
        .max(100)
        .describe('The plan_id of a migrate.plan with against "database".'),
      confirm: z.literal(true).describe("true: the person read the plan and wants the run."),
    }),
    outputKeys: IMPORT_KEYS,
  },
  {
    name: "schema.migrate",
    title: "Migrate the Postgres schema of authtempo",
    description:
      "Writes the authtempo migrations into the Postgres database that the server's environment names, after a dry run. With dry_run: true it writes nothing, and answers the pending migrations and a plan_id. With that plan_id and confirm: true it runs the dry run again, refuses when the database changed, and applies the plan. D1 is not a tool: run `authtempo migrate --target d1` in the shell.",
    surfaces: ["local"],
    wraps: {
      command: "migrate",
      positional: [],
      flags: { tables: "tables" },
      // --url-env <NAME> follows: the server's --url-env, never a tool input.
      // A dry run also passes --dry-run.
      fixed: ["--target", "postgres", "--json"],
      toolOnly: ["dry_run", "plan_id", "confirm"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    // The handler takes one of two modes: dry_run: true alone, or plan_id
    // with confirm: true. Each other mix is an input error.
    input: z.strictObject({
      tables: z
        .enum(["core", "compat"])
        .default("core")
        .describe("The table set: core, or compat for a Better Auth schema."),
      dry_run: z
        .boolean()
        .optional()
        .describe("true: list the pending migrations, write nothing, and answer a plan_id."),
      plan_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("The plan_id of a dry run of this tool. Give it with confirm: true."),
      confirm: z
        .boolean()
        .optional()
        .describe("true with plan_id: the person read the plan and wants the run."),
    }),
    outputKeys: [...MIGRATE_KEYS, "plan_id", "next"],
  },
  {
    name: "check",
    title: "Check a deployed authtempo API",
    description:
      "Fetches the public documents of a deployment from this machine, sends no credential, and writes nothing. It runs authtempo check on base_url, and fetches no other origin. It answers each check as its id, status, code, and docs link, and each warning as its code. It answers no text of the deployment. The tool skips the schema check: run authtempo check with --target in the shell for it.",
    surfaces: ["local"],
    wraps: {
      command: "check",
      positional: ["base_url"],
      flags: { base_path: "base-path", strict: "strict" },
      fixed: ["--json"],
      toolOnly: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: z.strictObject({
      base_url: z
        .string()
        .max(2048)
        .refine(
          httpOrigin,
          "base_url is an http or https origin with no path, query, fragment, or credentials",
        )
        .describe("The origin of the deployment, such as https://api.example.com."),
      // A leading slash keeps the value from a read as a flag of the CLI.
      base_path: z
        .string()
        .min(1)
        .max(200)
        .regex(/^\//)
        .default("/auth")
        .describe("The basePath of the deployment's config, /auth by default."),
      strict: z.boolean().default(false).describe("true: each skip counts as a failure."),
    }),
    outputKeys: CHECK_KEYS,
  },
];
