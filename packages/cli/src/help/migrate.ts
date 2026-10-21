import { URL_AND_FILE_FLAGS } from "./check.js";
import { COMMON_FLAGS, type HelpText } from "./types.js";

export const MIGRATE_HELP: HelpText = {
  command: "migrate",
  page: "migrate",
  purpose:
    "Apply the migrations of the installed adapter. The command reads the schema version first, and stops on a newer database.",
  usage: [
    "authtempo migrate --target postgres [--url-env <NAME> | --url-file <path>] [--tables core|compat] [--dry-run]",
    "authtempo migrate --target d1 [--database <name>] [--config <path>] [--remote] [--tables core|compat [--before-1.7]] [--dry-run]",
    "authtempo migrate --target sqlite (--file <path> | --url-env <NAME> | --url-file <path>) [--auth-token-env <NAME> | --auth-token-file <path>] [--dry-run]",
    "authtempo migrate --target mysql [--url-env <NAME> | --url-file <path>] [--dry-run]",
  ],
  examples: [
    {
      line: "authtempo migrate --target postgres --url-env DATABASE_URL",
      says: "Apply the Postgres migrations. The connection string is in DATABASE_URL.",
    },
    {
      line: "authtempo migrate --target d1 --database my-app --remote",
      says: "Apply the D1 migrations to the database on Cloudflare, through the wrangler of the project.",
    },
    {
      line: "authtempo migrate --target sqlite --file ./auth.db",
      says: "Create or update the tables in a SQLite file.",
    },
    {
      line: "authtempo migrate --target mysql --url-env DATABASE_URL --dry-run",
      says: "List the migrations that a MySQL database lacks.",
    },
  ],
  flags: [
    {
      flag: "--target <d1|postgres|sqlite|mysql>",
      says: "The kind of database. It has no default.",
    },
    {
      flag: "--tables <core|compat>",
      says: "Core's tables, or the Better Auth 1.7 tables of the compatibility package. The default is core.",
    },
    ...URL_AND_FILE_FLAGS,
    {
      flag: "--database <name>",
      says: "D1: the database_name in the wrangler config. A project with one D1 database needs no name.",
    },
    {
      flag: "--config <path>",
      says: "D1: the wrangler config of the project. The default is wrangler.jsonc or wrangler.json in this folder.",
    },
    {
      flag: "--remote",
      says: "D1: apply to the database on Cloudflare. Local is the default: without --remote, the run is on the local database of wrangler dev.",
    },
    {
      flag: "--before-1.7",
      says: "D1 with --tables compat: copy the files for tables from before Better Auth 1.7.",
    },
    { flag: "-n, --dry-run", says: "List the migrations that a run applies, and apply nothing." },
    ...COMMON_FLAGS,
  ],
  exits: [
    {
      code: 0,
      says: "The database is at the schema version of this CLI, or the dry run listed the migrations.",
    },
    {
      code: 2,
      says: "A usage error, a newer database, a database that does not answer, an edited compat copy, or a migration that failed.",
    },
  ],
  notes: [
    "With --tables compat, the command warns when the project holds better-auth below 1.7.7.",
    "With --target sqlite --file, the command makes the file when it is missing.",
  ],
};
