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
    {
      line: "authtempo init my-app --stack workers-d1",
      says: "Write a new Worker app on D1 into the folder my-app.",
    },
    {
      line: "authtempo check https://api.example.com",
      says: "Check that a deployment answers as core promises.",
    },
  ],
  flags: [
    { flag: "--version", says: "Print the version of the CLI and the schema version of its core." },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "Done. Every check passed, or the command made the change that it named." },
    { code: 1, says: "A person must look: a check failed, or an import record needs a person." },
    {
      code: 2,
      says: "A usage error, a malformed input, or a stop. A stop prints one stopped line.",
    },
  ],
};
