import { COMMON_FLAGS, type HelpFlag, type HelpText } from "./types.js";

const TOKEN_FILE = "--token-file <path>";
const TOKEN_FILE_SAYS = "The file that holds the operator secret. A dash reads stdin";

/**
 * The four flags of a command that calls an operator route (plan 11c2):
 * `keys rotate`, `secret status`, `secret rewrap`, and `info`. One list, so
 * the four helps say the same words. A command with `--yes` adds its clause
 * through `operatorFlagsWithYes`.
 */
export const OPERATOR_FLAGS: readonly HelpFlag[] = [
  {
    flag: "--token-env <NAME>",
    says: "The variable that holds the operator secret. The default is AUTHTEMPO_OPERATOR_SECRET.",
  },
  {
    flag: TOKEN_FILE,
    says: `${TOKEN_FILE_SAYS}.`,
  },
  { flag: "--base-path <path>", says: "The basePath of the deployment. The default is /auth." },
  {
    flag: "--timeout <seconds>",
    says: "The time limit of each request, from 1 to 120 seconds. The default is 10.",
  },
];

/**
 * `OPERATOR_FLAGS` for a command that asks a question: a dash in
 * `--token-file` reads stdin to its end, so the command then needs `--yes`.
 * `keys rotate` and `secret rewrap` spread this list; `secret status` and
 * `info` ask no question and spread `OPERATOR_FLAGS`.
 */
export function operatorFlagsWithYes(): HelpFlag[] {
  return OPERATOR_FLAGS.map((f) =>
    f.flag === TOKEN_FILE
      ? { ...f, says: `${TOKEN_FILE_SAYS}, and then the command needs --yes.` }
      : f,
  );
}

export const KEYS_HELP: HelpText = {
  command: "keys rotate",
  page: "keys",
  purpose:
    "Make a new signing key on a deployment. The old key verifies for 24 hours and signs nothing.",
  usage: ["authtempo keys rotate <base url> [--token-env <NAME> | --token-file <path>] --yes"],
  examples: [
    {
      line: "authtempo keys rotate https://api.example.com --yes",
      says: "Rotate the signing key with the operator secret in AUTHTEMPO_OPERATOR_SECRET.",
    },
    {
      line: "authtempo keys rotate https://api.example.com --token-file operator.txt --yes",
      says: "Read the operator secret from a file.",
    },
  ],
  flags: [
    ...operatorFlagsWithYes(),
    { flag: "--yes", says: "Rotate with no question. A run with no terminal needs it." },
    { flag: "--no-input", says: "Never ask a question. Without --yes, the command then stops." },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The deployment made a new key. The command prints its kid." },
    {
      code: 2,
      says: "A usage error, or a stop: no answer, the route is off, or the deployment refused the secret.",
    },
  ],
};
