import { END_ALL_MAX } from "../operator-tools.js";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { COMMON_FLAGS, type HelpFlag, type HelpText } from "./types.js";
import { GROUP_EXITS, REASON_FLAG, WRITE_FLAGS, writeStop } from "./users.js";

const TOKEN = "[--token-env <NAME> | --token-file <path>]";

/** The limit of calls of one run, as `secret rewrap` has it. */
const MAX_CALLS_FLAG: HelpFlag = {
  flag: "--max-calls <n>",
  says: `The most calls of one run, from 1 to ${MAX_CALLS_MAX}. The default is ${DEFAULT_MAX_CALLS}.`,
};

export const SESSIONS_HELP: HelpText = {
  command: "sessions",
  page: "sessions",
  purpose:
    "End the sessions of one user or of all users through the operator user tools (ASVS 5.0.0 7.4.5). Each call writes an audit row.",
  usage: [
    "authtempo sessions end <base url> <user id> --reason <text> --yes",
    "authtempo sessions end-all <base url> --reason <text> [--limit <n>] [--max-calls <n>] --yes",
  ],
  examples: [
    {
      line: 'authtempo sessions end https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "stolen laptop" --yes',
      says: "End every session of one user.",
    },
  ],
  flags: [...COMMON_FLAGS],
  exits: GROUP_EXITS,
};

export const SESSIONS_END_HELP: HelpText = {
  command: "sessions end",
  page: "sessions-end",
  purpose:
    "End every session of one user. The command calls the deployment until no session of the user is left, or the run reaches --max-calls.",
  usage: [
    `authtempo sessions end <base url> <user id> --reason <text> [--max-calls <n>] ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo sessions end https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "stolen laptop" --yes',
      says: "End every session of one user.",
    },
  ],
  flags: [REASON_FLAG, MAX_CALLS_FLAG, ...WRITE_FLAGS],
  exits: [
    { code: 0, says: "No session of the user is left. The command prints the sums." },
    { code: 1, says: "The run reached --max-calls with sessions left. Run it again." },
    { code: 2, says: writeStop("sessions") },
  ],
};

export const SESSIONS_END_ALL_HELP: HelpText = {
  command: "sessions end-all",
  page: "sessions-end-all",
  purpose:
    "End the sessions of every user. The command calls the deployment until no session is left, or the run reaches --max-calls.",
  usage: [
    `authtempo sessions end-all <base url> --reason <text> [--limit <n>] [--max-calls <n>] ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo sessions end-all https://api.example.com --reason "breach" --yes',
      says: "End every session of every user.",
    },
  ],
  flags: [
    REASON_FLAG,
    {
      flag: "--limit <n>",
      says: `The most sessions of one call, from 1 to ${END_ALL_MAX}. The default is 500. A call can end fewer.`,
    },
    MAX_CALLS_FLAG,
    ...WRITE_FLAGS,
  ],
  exits: [
    { code: 0, says: "No session is left. The command prints the sums." },
    { code: 1, says: "The run reached --max-calls with sessions left. Run it again." },
    { code: 2, says: writeStop("sessions") },
  ],
};
