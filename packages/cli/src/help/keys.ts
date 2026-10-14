import { COMMON_FLAGS, type HelpText } from "./types.js";

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
    {
      flag: "--token-env <NAME>",
      says: "The variable that holds the operator secret. The default is AUTHTEMPO_OPERATOR_SECRET.",
    },
    {
      flag: "--token-file <path>",
      says: "The file that holds the operator secret. A dash reads stdin, and then the command needs --yes.",
    },
    { flag: "--base-path <path>", says: "The basePath of the deployment. The default is /auth." },
    {
      flag: "--timeout <seconds>",
      says: "The time limit of each request, from 1 to 120 seconds. The default is 10.",
    },
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
