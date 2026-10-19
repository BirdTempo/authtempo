import { SECRET_VERSION_MAX } from "@authtempo/core/secrets";
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
