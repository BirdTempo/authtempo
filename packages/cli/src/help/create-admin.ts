import type { HelpText } from "./types.js";
import { REASON_FLAG, WRITE_FLAGS, writeStop } from "./users.js";

export const CREATE_ADMIN_HELP: HelpText = {
  command: "create-admin",
  page: "create-admin",
  purpose:
    "Make the first platform operator of a deployment. The command makes the platform organization and the user when they are absent.",
  usage: [
    "authtempo create-admin <base url> --email <address> [--name <name>] --reason <text> [--token-env <NAME> | --token-file <path>] --yes",
  ],
  examples: [
    {
      line: 'authtempo create-admin https://api.example.com --email root@example.com --reason "first operator" --yes',
      says: "Make the first operator with the operator secret in AUTHTEMPO_OPERATOR_SECRET.",
    },
  ],
  flags: [
    {
      flag: "--email <address>",
      says: "The address of the operator. The command prints no address on stderr.",
    },
    { flag: "--name <name>", says: "The name of a new user, from 1 to 200 characters." },
    REASON_FLAG,
    ...WRITE_FLAGS,
  ],
  exits: [
    {
      code: 0,
      says: "The deployment made the operator. The command prints the user id. The user has no power before a sign-in and a second factor.",
    },
    { code: 2, says: writeStop("users") },
  ],
};
