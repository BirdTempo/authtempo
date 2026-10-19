import { COMMON_FLAGS, type HelpText } from "./types.js";

/** The help of the program itself. main adds the command table. */
export const ROOT_HELP: HelpText = {
  command: "",
  page: "",
  purpose: "Set up, migrate, import into, check, and maintain an authtempo deployment.",
  usage: [
    "authtempo <command> [arguments] [flags]",
    "authtempo help <command>",
    "authtempo --version",
  ],
  examples: [
    // Only commands of the table: the common test holds each example's command to it.
    {
      line: "authtempo init my-app --stack workers-d1",
      says: "Write a new app on Cloudflare Workers and D1 into the folder my-app.",
    },
    {
      line: "authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt --target postgres --dry-run",
      says: "Print the report of a Supabase import, and write nothing.",
    },
    {
      line: "authtempo check https://api.example.com",
      says: "Check that the deployment answers as core promises. Exit 1 names each failure.",
    },
    {
      line: "authtempo keys rotate https://api.example.com --yes",
      says: "Rotate the signing key with the operator secret in AUTHTEMPO_OPERATOR_SECRET.",
    },
  ],
  flags: [
    { flag: "--version", says: "Print the version of the CLI and the schema version of its core." },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "Done. Every check passed, or the command made the change that it named." },
    {
      code: 1,
      says: "A person must look: a check failed, a record or a row needs a person, or a part of the report gave no answer.",
    },
    {
      code: 2,
      says: "A usage error, a malformed input, or a stop. A stop prints one stopped line.",
    },
  ],
};
