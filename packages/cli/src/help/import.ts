import { COMMON_FLAGS, type HelpText } from "./types.js";

export const IMPORT_HELP: HelpText = {
  command: "import",
  page: "import",
  purpose:
    "Move the users of Supabase, Clerk, Auth0, Firebase, Auth.js, or Cognito into authtempo. A second run writes nothing.",
  usage: [
    "authtempo import <provider> [the files of the provider] --formats <list> --target <postgres|d1-bundle> [flags]",
  ],
  examples: [
    {
      line: "authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt --target postgres --dry-run",
      says: "Print the report of a Supabase import, and write nothing.",
    },
    {
      line: "authtempo import authjs --authjs-tables tables.json --formats bcrypt --target d1-bundle --out input/import.local.json",
      says: "Write the bundle of an Auth.js import for the D1 import Worker.",
    },
  ],
  flags: [
    {
      flag: "--target <postgres|d1-bundle>",
      says: "Write into Postgres, or write a bundle for the D1 import Worker and stop. It has no default.",
    },
    {
      flag: "--tables <core|compat>",
      says: "Postgres: core's tables, or the Better Auth 1.7 tables of the compatibility package. The default is core.",
    },
    {
      flag: "--url-env <NAME>",
      says: "Postgres: the variable that holds the connection string. The default is DATABASE_URL.",
    },
    {
      flag: "--url-file <path>",
      says: "Postgres: the file that holds the connection string. A dash reads stdin.",
    },
    {
      flag: "--out <file>",
      says: "d1-bundle: the file of the bundle, with mode 0600. Warning: it holds every password hash. Delete it after the Worker run.",
    },
    {
      flag: "--users <file>",
      says: "The users file of supabase, clerk, auth0, firebase, or cognito.",
    },
    { flag: "--identities <file>", says: "supabase: the identities CSV." },
    { flag: "--csv <file>", says: "clerk: the CSV export with the password hashes." },
    { flag: "--hashes <file>", says: "auth0: the NDJSON file of the password hashes." },
    { flag: "--organizations <file>", says: "clerk and auth0: the organizations file." },
    {
      flag: "--authjs-tables <file>",
      says: "authjs: the JSON file of the User, Account, and Authenticator rows.",
    },
    {
      flag: "--firebase-signer-key-env <NAME>",
      says: "supabase: the variable that holds the Firebase signer key.",
    },
    {
      flag: "--firebase-signer-key-file <path>",
      says: "supabase: the file that holds the Firebase signer key.",
    },
    {
      flag: "--firebase-salt-separator <value>",
      says: "supabase: the Firebase salt separator. Give it with the signer key.",
    },
    {
      flag: "--firebase-rounds <n>",
      says: "firebase: the rounds of the hash config of the project.",
    },
    {
      flag: "--firebase-mem-cost <n>",
      says: "firebase: the mem_cost of the hash config of the project.",
    },
    { flag: "--password-column <name>", says: "authjs: the password column of the User table." },
    {
      flag: "--same-passkey-rp-id",
      says: "authjs: the new app keeps the relying party id, so the passkeys move.",
    },
    {
      flag: "--formats <list>",
      says: "The formats list of the app's createLegacyPasswordHash, with commas, or none. Only cognito may leave it out.",
    },
    {
      flag: "--legacy-verify",
      says: "The app sets password.legacyVerify. A cognito import needs it.",
    },
    {
      flag: "--on-email-taken <skip|fail>",
      says: "Skip a record whose address is taken, or stop the run. The default is skip.",
    },
    {
      flag: "--role-map <list>",
      says: "Map the roles of the source to owner, admin, or member, such as lead=admin.",
    },
    {
      flag: "--reserved-slugs <list>",
      says: "The organizations.reservedSlugs of the app, with commas. The defaults of core stay reserved.",
    },
    {
      flag: "--platform-slug <slug>",
      says: "The platform organization slug of the app. No import takes it.",
    },
    {
      flag: "--repair",
      says: "Write the rows that a partial record lacks. Check each such user in the app first.",
    },
    { flag: "--report <file>", says: "Also write the report as JSON, with mode 0600 and no hash." },
    { flag: "-n, --dry-run", says: "Read only, and print the report that a real run prints." },
    ...COMMON_FLAGS,
  ],
  exits: [
    {
      code: 0,
      says: "Clean: every record imported, or skipped for a reason that the export states.",
    },
    {
      code: 1,
      says: "A person must look: a refused hash, a refused record, a conflict, or a partial record.",
    },
    {
      code: 2,
      says: "A usage error, a malformed input file, or a stop. A stop prints one stopped line.",
    },
  ],
};
