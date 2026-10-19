import { COMMON_FLAGS, type HelpFlag, type HelpText } from "./types.js";

/**
 * The five inputs of a database read (plan 11c2): `check` and `info` list
 * them under `--target`. One list, so the two helps say the same words.
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

export const CHECK_HELP: HelpText = {
  command: "check",
  page: "check",
  purpose:
    "Check that a deployment answers as core promises. It reads public documents only, and a skipped check never counts as a pass.",
  usage: [
    "authtempo check <base url> [--base-path <path>] [--target <d1|postgres> and its inputs] [--strict]",
  ],
  examples: [
    {
      line: "authtempo check https://api.example.com",
      says: "Check the routes, the origin rule, the cookie, the key set, and the well-known documents.",
    },
    {
      line: "authtempo check https://api.example.com --target postgres --url-env DATABASE_URL",
      says: "Also compare the schema version and the tables of the database with this CLI.",
    },
  ],
  flags: [
    { flag: "--base-path <path>", says: "The basePath of the deployment. The default is /auth." },
    {
      flag: "--timeout <seconds>",
      says: "The time limit of each request, from 1 to 120 seconds. The default is 10.",
    },
    { flag: "--strict", says: "Count each skipped check as a failure." },
    {
      flag: "--target <d1|postgres>",
      says: "Read the schema version and the table shape from this kind of database. Without it, the two schema checks skip.",
    },
    ...DATABASE_FLAGS,
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "No check failed. A warning or a skip is no failure." },
    { code: 1, says: "A check failed. A person must look." },
    {
      code: 2,
      says: "A usage error, a host or a database that gives no answer, or a schema version that this CLI cannot read.",
    },
  ],
};
