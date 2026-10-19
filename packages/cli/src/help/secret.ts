import { REWRAP_LIMIT, SECRET_VERSION_MAX } from "@authtempo/core/secrets";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { OPERATOR_FLAGS } from "./keys.js";
import { COMMON_FLAGS, type HelpText } from "./types.js";

export const SECRET_HELP: HelpText = {
  command: "secret",
  page: "secret",
  purpose:
    "Make a new app secret or operator secret from 32 random bytes. The command prints the value once and keeps no copy.",
  usage: [
    "authtempo secret [--version <n>] [--out <path>]",
    "authtempo secret --operator [--out <path>]",
  ],
  examples: [
    {
      line: "authtempo secret --version 2",
      says: "Make version 2 of the app secret, and print it once.",
    },
    {
      line: "authtempo secret --version 2 --out secret-v2.txt",
      says: "Write version 2 to a new file that only you can read.",
    },
    {
      line: "authtempo secret --operator",
      says: "Make an operator secret, and print the hash for the config.",
    },
  ],
  flags: [
    {
      flag: "--version <n>",
      says: `The version of the app secret, from 1 to ${SECRET_VERSION_MAX}. The value does not change with it.`,
    },
    {
      flag: "--out <path>",
      says: "Write the value to a new file with mode 0600. The command refuses a path that exists. It needs --version or --operator.",
    },
    {
      flag: "--operator",
      says: "Make an operator secret, and print its SHA-256 for operator.secretHash. Do not give it with --version.",
    },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The command printed or wrote the value." },
    {
      code: 2,
      says: "A usage error, a path that exists, or a stop: the random source gave three weak values.",
    },
  ],
};

export const SECRET_STATUS_HELP: HelpText = {
  command: "secret status",
  page: "secret-status",
  purpose:
    "Count the rows of each app secret version on a deployment. The command reads counts only, never a value.",
  usage: ["authtempo secret status <base url> [--token-env <NAME> | --token-file <path>]"],
  examples: [
    {
      line: "authtempo secret status https://api.example.com",
      says: "Read the counts with the operator secret in AUTHTEMPO_OPERATOR_SECRET.",
    },
  ],
  flags: [...OPERATOR_FLAGS, ...COMMON_FLAGS],
  exits: [
    { code: 0, says: "Each version that has rows is in the config." },
    {
      code: 1,
      says: "A version that the config does not hold has rows. A person must look before the version goes.",
    },
    {
      code: 2,
      says: "A usage error, or a stop: no answer, the route is off, or the deployment refused the secret.",
    },
  ],
};

export const SECRET_REWRAP_HELP: HelpText = {
  command: "secret rewrap",
  page: "secret-rewrap",
  purpose:
    "Reseal the rows of the old app secret versions under the current version. The command calls the deployment until no row moves.",
  usage: [
    "authtempo secret rewrap <base url> [--limit <n>] [--max-calls <n>] [--token-env <NAME> | --token-file <path>] --yes",
  ],
  examples: [
    {
      line: "authtempo secret rewrap https://api.example.com --yes",
      says: "Reseal every old row, 100 rows in each call.",
    },
  ],
  flags: [
    {
      flag: "--limit <n>",
      says: `The rows of one call, from 1 to ${REWRAP_LIMIT.max}. The default is ${REWRAP_LIMIT.default}.`,
    },
    {
      flag: "--max-calls <n>",
      says: `The most calls of one run, from 1 to ${MAX_CALLS_MAX}. The default is ${DEFAULT_MAX_CALLS}.`,
    },
    ...OPERATOR_FLAGS,
    { flag: "--yes", says: "Reseal with no question. A run with no terminal needs it." },
    { flag: "--no-input", says: "Never ask a question. Without --yes, the command then stops." },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "No row of a configured old version remains." },
    {
      code: 1,
      says: "A row did not open, or rows remain after the last call. A person must look.",
    },
    {
      code: 2,
      says: "A usage error, or a stop: no answer, the route is off, the deployment refused the secret, or the limit of calls.",
    },
  ],
};
