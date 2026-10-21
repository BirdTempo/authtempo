import { COMMON_FLAGS, type HelpFlag, type HelpText } from "./types.js";

/** The three D1 inputs of a database read (plan 11c2). `check` and `info` list them under `--target`. */
const D1_FLAGS: readonly HelpFlag[] = [
  { flag: "--database <name>", says: "D1: the database_name in the wrangler config." },
  {
    flag: "--config <path>",
    says: "D1: the wrangler config of the project. The default is wrangler.jsonc.",
  },
  {
    flag: "--remote",
    says: "D1: read the database on Cloudflare. The default is the local database.",
  },
];

/**
 * The five inputs of a database read (plan 11c2): `info` lists them under
 * `--target`. `check` lists the same D1 lines, so the two helps say the
 * same words.
 */
export const DATABASE_FLAGS: readonly HelpFlag[] = [
  {
    flag: "--url-env <NAME>",
    says: "Postgres: the variable that holds the connection string. The default is DATABASE_URL.",
  },
  {
    flag: "--url-file <path>",
    says: "Postgres: the file that holds the connection string. A dash reads stdin.",
  },
  ...D1_FLAGS,
];

/**
 * The inputs of the SQLite and MySQL targets (plan 12g Task 6). `migrate`
 * and `check` list them, so the two helps say the same words.
 */
export const URL_AND_FILE_FLAGS: readonly HelpFlag[] = [
  {
    flag: "--url-env <NAME>",
    says: "Postgres and MySQL: the variable that holds the connection string. The default is DATABASE_URL. SQLite: the variable that holds a libSQL URL.",
  },
  {
    flag: "--url-file <path>",
    says: "Postgres, MySQL, and SQLite: the file that holds the connection string or the libSQL URL. A dash reads stdin.",
  },
  { flag: "--file <path>", says: "SQLite: the path of the database file." },
  {
    flag: "--auth-token-env <NAME>",
    says: "SQLite with a libSQL URL: the variable that holds the token. The default is LIBSQL_AUTH_TOKEN. With no such variable, the command sends no token.",
  },
  {
    flag: "--auth-token-file <path>",
    says: "SQLite with a libSQL URL: the file that holds the token. A dash reads stdin.",
  },
];

export const CHECK_HELP: HelpText = {
  command: "check",
  page: "check",
  purpose:
    "Check that a deployment answers as core promises. It reads public documents only, and a skipped check never counts as a pass.",
  usage: [
    "authtempo check <base url> [--base-path <path>] [--target <d1|postgres|sqlite|mysql> and its inputs] [--strict]",
  ],
  examples: [
    {
      line: "authtempo check https://api.example.com",
      says: "Check the routes, the origin rule, the cookie, the key set, the well-known documents, and the health and readiness routes.",
    },
    {
      line: "authtempo check https://api.example.com --target postgres --url-env DATABASE_URL",
      says: "Also compare the schema version and the tables of the database with this CLI.",
    },
    {
      line: "authtempo check https://api.example.com --target sqlite --file ./auth.db",
      says: "Compare the schema version and the tables of a SQLite file with this CLI.",
    },
  ],
  flags: [
    { flag: "--base-path <path>", says: "The basePath of the deployment. The default is /auth." },
    {
      flag: "--timeout <seconds>",
      says: "The time limit of each request, from 1 to 120 seconds. The default is 10.",
    },
    { flag: "--strict", says: "Count each skipped check as a failure, except compat_database." },
    {
      flag: "--target <d1|postgres|sqlite|mysql>",
      says: "Read the schema version and the table shape from this kind of database. Without it, the two schema checks skip.",
    },
    ...URL_AND_FILE_FLAGS,
    ...D1_FLAGS,
    ...COMMON_FLAGS,
  ],
  notes: ["With --target sqlite --file, the command opens the file read-only and makes no file."],
  exits: [
    { code: 0, says: "No check failed. A warning or a skip is no failure." },
    { code: 1, says: "A check failed. A person must look." },
    {
      code: 2,
      says: "A usage error, a host or a database that gives no answer, or a schema version that this CLI cannot read.",
    },
  ],
};
