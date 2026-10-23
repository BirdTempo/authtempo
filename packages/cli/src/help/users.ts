import {
  DELETES_PER_HOUR,
  PAGE_MAX,
  PROOF_MAX_AGE_MS,
  PROOF_METHODS,
  REASON_RULE,
  REFERENCE_MAX,
  TOOL_CALLS_PER_HOUR,
} from "../operator-tools.js";

/** The age limit of a proof in whole days, for the help: 7. */
export const PROOF_DAYS = PROOF_MAX_AGE_MS / 86_400_000;

import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { OPERATOR_FLAGS, operatorFlagsWithYes } from "./keys.js";
import { COMMON_FLAGS, type HelpFlag, type HelpText } from "./types.js";

/** The exit 2 text of a command of the user tools, with the scope that its routes need. */
export function toolStop(scope: string): string {
  return `A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no ${scope} scope, or the limit of ${TOOL_CALLS_PER_HOUR} calls an hour.`;
}

/** The exit 2 text of a write: the stop of a read, and a refusal of the act. */
export function writeStop(scope: string): string {
  return `${toolStop(scope)} A refusal of the act stops too, with its cause.`;
}

/** The exit 1 text of a ban and a revoke that answer `familyEndFailed: true` (ruling 37 of plan 12f). */
export const FAMILY_END_EXIT =
  "The act ran, but the end of the OAuth refresh families failed. The command prints the audit row id and a warning. Run authtempo sessions end for the user.";

/**
 * What a ban and a revoke of the platform role do to the sessions (ruling 62
 * m4). The help and the pages take this one text. The act ends one page of
 * the sessions inside its call budget, and the sweep ends the rest. Until
 * then each door refuses a left session (ruling 44 of plan 12f).
 */
export const SESSION_PAGE_TEXT =
  "The act ends a page of the user's sessions, and the sweep ends the rest.";

/** The two lines of the parent help of a command with subcommands. */
export const GROUP_EXITS: HelpText["exits"] = [
  { code: 0, says: "The command printed its help." },
  { code: 2, says: "A usage error: the command needs a subcommand." },
];

/** The flag of the reason of a write. */
export const REASON_FLAG: HelpFlag = {
  flag: "--reason <text>",
  says: `The audit row holds the reason of the act. It is ${REASON_RULE}.`,
};

/** The flags of the confirmation rule of each write, after the operator flags. */
export const WRITE_FLAGS: readonly HelpFlag[] = [
  ...operatorFlagsWithYes(),
  { flag: "--yes", says: "Do the act with no question. A run with no terminal needs it." },
  { flag: "--no-input", says: "Never ask a question. Without --yes, the command then stops." },
  ...COMMON_FLAGS,
];

/** The flags of each read, after its own flags. */
export const READ_FLAGS: readonly HelpFlag[] = [...OPERATOR_FLAGS, ...COMMON_FLAGS];

/** The flags of a paged read. */
export const PAGE_FLAGS: readonly HelpFlag[] = [
  { flag: "--after <id>", says: "Start after this id. The cursor of the page before gives it." },
  {
    flag: "--limit <n>",
    says: `The rows of one page, from 1 to ${PAGE_MAX}. The default is 50.`,
  },
  {
    flag: "--all",
    says: `Read each page after the first until the last page. A page then holds ${PAGE_MAX} rows unless --limit gives another count.`,
  },
  {
    flag: "--max-calls <n>",
    says: `The most calls of one run with --all, from 1 to ${MAX_CALLS_MAX}. The default is ${DEFAULT_MAX_CALLS}.`,
  },
];

/** The exit 1 line of a paged read. */
export const PAGE_CUT_EXIT = {
  code: 1,
  says: "The read reached --max-calls with more rows. The command printed the rows that it read.",
} as const;

const TOKEN = "[--token-env <NAME> | --token-file <path>]";

export const USERS_HELP: HelpText = {
  command: "users",
  page: "users",
  purpose:
    "Read and change the users of a deployment through the operator user tools. Each change writes an audit row.",
  usage: [
    "authtempo users list <base url> [--after <id>] [--limit <n>] [--all]",
    "authtempo users search <base url> --email <address> | --email-prefix <prefix> | --id <id>",
    "authtempo users get <base url> <user id>",
    "authtempo users ban <base url> <user id> --reason <text> [--until <date>] --yes",
    "authtempo users unban <base url> <user id> --reason <text> --yes",
    "authtempo users platform-role <base url> <user id> --grant | --revoke --reason <text> --yes",
    "authtempo users second-factor-off <base url> <user id> --reason <text> --proof-method <method> --proof-reference <text> --proof-checked-at <date> --yes",
    "authtempo users update <base url> <user id> [--name <name> | --no-name] [--image <url> | --no-image] --reason <text> --yes",
    "authtempo users delete <base url> <user id> --reason <text> [--yes]",
  ],
  examples: [
    {
      line: "authtempo users list https://api.example.com",
      says: "List the first 50 users with the operator secret in AUTHTEMPO_OPERATOR_SECRET.",
    },
    {
      line: "authtempo users search https://api.example.com --email ada@example.com",
      says: "Find the user of one address.",
    },
  ],
  flags: [...COMMON_FLAGS],
  exits: GROUP_EXITS,
};

export const USERS_LIST_HELP: HelpText = {
  command: "users list",
  page: "users-list",
  purpose:
    "List the users of a deployment by id, one page in each call. No answer holds a hash or a token.",
  usage: [
    `authtempo users list <base url> [--after <id>] [--limit <n>] [--all [--max-calls <n>]] ${TOKEN}`,
  ],
  examples: [
    {
      line: "authtempo users list https://api.example.com",
      says: "List the first 50 users.",
    },
    {
      line: "authtempo users list https://api.example.com --all --json",
      says: "Read every user into one JSON document.",
    },
  ],
  flags: [...PAGE_FLAGS, ...READ_FLAGS],
  exits: [
    { code: 0, says: "The command printed the users." },
    PAGE_CUT_EXIT,
    { code: 2, says: toolStop("users") },
  ],
};

export const USERS_SEARCH_HELP: HelpText = {
  command: "users search",
  page: "users-search",
  purpose:
    "Find users by an exact address, an exact id, or the start of an address. The address goes to stdout only.",
  usage: [
    `authtempo users search <base url> --email <address> | --email-prefix <prefix> | --id <id> [--after <id>] [--limit <n>] [--all [--max-calls <n>]] ${TOKEN}`,
  ],
  examples: [
    {
      line: "authtempo users search https://api.example.com --email ada@example.com",
      says: "Find the user of one address.",
    },
    {
      line: "authtempo users search https://api.example.com --email-prefix ada. --all",
      says: "Find every user whose address starts with ada.",
    },
  ],
  flags: [
    { flag: "--email <address>", says: "Find the user of this exact address." },
    {
      flag: "--email-prefix <prefix>",
      says: "Find the users whose address starts with this text, from 3 to 254 characters. The deployment reads every user for it.",
    },
    { flag: "--id <id>", says: "Find the user of this exact id." },
    ...PAGE_FLAGS,
    ...READ_FLAGS,
  ],
  exits: [
    { code: 0, says: "The command printed the users that match. No match prints the header only." },
    PAGE_CUT_EXIT,
    { code: 2, says: toolStop("users") },
  ],
};

export const USERS_GET_HELP: HelpText = {
  command: "users get",
  page: "users-get",
  purpose:
    "Read one user by id: the address, the ban, the platform operator flag, the second factors, and the sessions.",
  usage: [`authtempo users get <base url> <user id> ${TOKEN}`],
  examples: [
    {
      line: "authtempo users get https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3",
      says: "Read one user.",
    },
  ],
  flags: [...READ_FLAGS],
  exits: [
    { code: 0, says: "The command printed the user." },
    { code: 2, says: `${toolStop("users")} No user has the id stops too.` },
  ],
};

export const USERS_BAN_HELP: HelpText = {
  command: "users ban",
  page: "users-ban",
  purpose: `Ban a user, and refuse each new sign-in. ${SESSION_PAGE_TEXT}`,
  usage: [
    `authtempo users ban <base url> <user id> --reason <text> [--until <date>] ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo users ban https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "spam" --yes',
      says: "Ban a user with no end.",
    },
    {
      line: 'authtempo users ban https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "abuse" --until 2026-12-31T00:00:00Z --yes',
      says: "Ban a user until a date.",
    },
  ],
  flags: [
    REASON_FLAG,
    {
      flag: "--until <date>",
      says: "The end of the ban: a date and time with a zone, from 1 minute to 3650 days after now. Without it, the ban has no end.",
    },
    ...WRITE_FLAGS,
  ],
  exits: [
    { code: 0, says: "The deployment banned the user. The command prints the audit row id." },
    { code: 1, says: FAMILY_END_EXIT },
    { code: 2, says: writeStop("users") },
  ],
};

export const USERS_UNBAN_HELP: HelpText = {
  command: "users unban",
  page: "users-unban",
  purpose: "Lift the ban of a user. The user can sign in again. No session of the ban comes back.",
  usage: [`authtempo users unban <base url> <user id> --reason <text> ${TOKEN} --yes`],
  examples: [
    {
      line: 'authtempo users unban https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "appeal" --yes',
      says: "Lift a ban.",
    },
  ],
  flags: [REASON_FLAG, ...WRITE_FLAGS],
  exits: [
    { code: 0, says: "The deployment lifted the ban. The command prints the audit row id." },
    { code: 2, says: writeStop("users") },
  ],
};

export const USERS_PLATFORM_ROLE_HELP: HelpText = {
  command: "users platform-role",
  page: "users-platform-role",
  purpose: `Grant or revoke the platform role of a user in the platform organization. On a revoke: ${SESSION_PAGE_TEXT}`,
  usage: [
    `authtempo users platform-role <base url> <user id> --grant | --revoke --reason <text> ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo users platform-role https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --grant --reason "support lead" --yes',
      says: "Make a verified user a platform operator.",
    },
  ],
  flags: [
    {
      flag: "--grant",
      says: "Grant the role. The user needs a verified address and no active ban.",
    },
    { flag: "--revoke", says: `Revoke the role. ${SESSION_PAGE_TEXT}` },
    REASON_FLAG,
    ...WRITE_FLAGS,
  ],
  exits: [
    { code: 0, says: "The deployment changed the role. The command prints the audit row id." },
    { code: 1, says: `A revoke ran. ${FAMILY_END_EXIT}` },
    { code: 2, says: writeStop("users") },
  ],
};

export const USERS_SECOND_FACTOR_OFF_HELP: HelpText = {
  command: "users second-factor-off",
  page: "users-second-factor-off",
  purpose:
    "Turn every second factor of a user off after a check of the identity of the person. The user gets a notice mail.",
  usage: [
    `authtempo users second-factor-off <base url> <user id> --reason <text> --proof-method <method> --proof-reference <text> --proof-checked-at <date> ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo users second-factor-off https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "lost phone" --proof-method document --proof-reference case-4711 --proof-checked-at 2026-10-20T09:30:00Z --yes',
      says: "Turn the second factor off after a document check.",
    },
  ],
  flags: [
    REASON_FLAG,
    {
      flag: "--proof-method <method>",
      says: `How the identity was checked: ${PROOF_METHODS.slice(0, -1).join(", ")}, or ${PROOF_METHODS.at(-1)}.`,
    },
    {
      flag: "--proof-reference <text>",
      says: `The case id of the check in your own system, from 1 to ${REFERENCE_MAX} characters. Never the evidence itself.`,
    },
    {
      flag: "--proof-checked-at <date>",
      says: `The time of the check: a date and time with a zone, at most ${PROOF_DAYS} days old. The deployment refuses a time after its own clock.`,
    },
    ...WRITE_FLAGS,
  ],
  exits: [
    {
      code: 0,
      says: "The deployment turned the factors off. The command prints the audit row id.",
    },
    { code: 2, says: writeStop("users") },
  ],
};

/** The text after `invalid_body` of `users update`: the name rule and the image rule of core. */
export const UPDATE_INVALID =
  "--name is 1 to 200 UTF-16 code units with no control or format character, and --image is an https URL with a host, of at most 2048 characters, with no space";

export const USERS_UPDATE_HELP: HelpText = {
  command: "users update",
  page: "users-update",
  purpose:
    "Correct the name or the image of a user. The command sends no address, no password, and no other field.",
  usage: [
    `authtempo users update <base url> <user id> [--name <name> | --no-name] [--image <url> | --no-image] --reason <text> ${TOKEN} --yes`,
  ],
  examples: [
    {
      line: 'authtempo users update https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --name "Ada Lovelace" --reason "ticket 4711" --yes',
      says: "Correct the name of a user.",
    },
    {
      line: 'authtempo users update https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --no-image --reason "ticket 4712" --yes',
      says: "Remove the image of a user.",
    },
  ],
  flags: [
    {
      flag: "--name <name>",
      says: "The new name: 1 to 200 UTF-16 code units with no control or format character.",
    },
    { flag: "--no-name", says: "Remove the name. The user then has no name." },
    {
      flag: "--image <url>",
      says: "The new image: an https URL with a host, of at most 2048 characters, with no space.",
    },
    { flag: "--no-image", says: "Remove the image. The user then has no image." },
    REASON_FLAG,
    ...WRITE_FLAGS,
  ],
  exits: [
    { code: 0, says: "The deployment changed the user. The command prints the audit row id." },
    { code: 2, says: writeStop("users") },
  ],
  notes: [
    "Give at least one of --name, --no-name, --image, and --no-image. The audit row names the changed fields, never a value.",
  ],
};

export const USERS_DELETE_HELP: HelpText = {
  command: "users delete",
  page: "users-delete",
  purpose:
    "Delete the account of a user on a request. The organizations that the user alone holds go with it. It cannot be undone.",
  usage: [`authtempo users delete <base url> <user id> --reason <text> ${TOKEN} [--yes]`],
  examples: [
    {
      line: 'authtempo users delete https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "request 4713"',
      says: "Delete an account. The command asks for the user id.",
    },
    {
      line: 'authtempo users delete https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "request 4713" --yes',
      says: "Delete an account from a script, with no question.",
    },
  ],
  flags: [
    REASON_FLAG,
    ...operatorFlagsWithYes(),
    {
      flag: "--yes",
      says: "Delete with no question. A run with no terminal needs it.",
    },
    { flag: "--no-input", says: "Never ask a question. Without --yes, the command then stops." },
    ...COMMON_FLAGS,
  ],
  exits: [
    {
      code: 0,
      says: "The deployment deleted the account. The command prints the audit row id and each organization that went with it.",
    },
    { code: 2, says: writeStop("delete") },
  ],
  notes: [
    "The secret needs the delete scope beside the users scope.",
    "Without --yes, the command asks for the user id. Only the typed user id deletes the account; yes does not.",
    `Each call counts on ${DELETES_PER_HOUR} deletes per actor per hour, also a refused call.`,
  ],
};
