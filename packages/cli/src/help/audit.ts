import { AUDIT_CSV_COLUMNS, PAGE_MAX } from "../operator-tools.js";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { OPERATOR_FLAGS } from "./keys.js";
import { COMMON_FLAGS, type HelpText } from "./types.js";
import { GROUP_EXITS, PAGE_CUT_EXIT, PAGE_FLAGS, READ_FLAGS, toolStop } from "./users.js";

/**
 * The stderr line of each `audit export` run (plan 13b Task 8). Core writes
 * the organization of a row from schema version 18. A row from before has
 * no organization, so the export of an organization does not hold it.
 */
export const EXPORT_NOTE =
  "the organization audit starts at schema version 18; rows before it have no organization";

export const AUDIT_HELP: HelpText = {
  command: "audit",
  page: "audit",
  purpose:
    "Read the audit rows of the operator acts of a deployment. Core writes one row for each act and changes no row.",
  usage: [
    "authtempo audit list <base url> [--user <id>] [--after <id>] [--limit <n>] [--all]",
    "authtempo audit export <base url> --organization <id> --format ndjson|csv",
  ],
  examples: [
    {
      line: "authtempo audit list https://api.example.com",
      says: "List the first 50 audit rows.",
    },
    {
      line: "authtempo audit export https://api.example.com --organization 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --format csv",
      says: "Write the audit rows of one organization as CSV.",
    },
  ],
  flags: [...COMMON_FLAGS],
  exits: GROUP_EXITS,
};

export const AUDIT_LIST_HELP: HelpText = {
  command: "audit list",
  page: "audit-list",
  purpose:
    "List the audit rows of the operator acts by id, the oldest first. A row names a secret by its name, never by its value.",
  usage: [
    "authtempo audit list <base url> [--user <id>] [--after <id>] [--limit <n>] [--all [--max-calls <n>]] [--token-env <NAME> | --token-file <path>]",
  ],
  examples: [
    {
      line: "authtempo audit list https://api.example.com --user 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3",
      says: "List the audit rows of the acts on one user.",
    },
    {
      line: "authtempo audit list https://api.example.com --all --json",
      says: "Read every audit row into one JSON document.",
    },
  ],
  flags: [
    { flag: "--user <id>", says: "List only the rows of the acts on this user." },
    ...PAGE_FLAGS,
    ...READ_FLAGS,
  ],
  exits: [
    { code: 0, says: "The command printed the rows." },
    PAGE_CUT_EXIT,
    { code: 2, says: toolStop("audit") },
  ],
};

export const AUDIT_EXPORT_HELP: HelpText = {
  command: "audit export",
  page: "audit-export",
  purpose:
    "Write the audit rows of one organization to stdout, one row per line, the oldest first. The command reads each page.",
  usage: [
    "authtempo audit export <base url> --organization <id> --format ndjson|csv [--after <id>] [--limit <n>] [--max-calls <n>] [--token-env <NAME> | --token-file <path>]",
  ],
  examples: [
    {
      line: "authtempo audit export https://api.example.com --organization 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --format ndjson > audit.ndjson",
      says: "Write each audit row of one organization as one JSON object per line.",
    },
    {
      line: "authtempo audit export https://api.example.com --organization 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --format csv > audit.csv",
      says: "Write a CSV file with a header line.",
    },
  ],
  flags: [
    { flag: "--organization <id>", says: "The id of the organization. The command needs it." },
    {
      flag: "--format ndjson|csv",
      says: "The format of stdout. A CSV cell that starts with =, +, -, @, a tab, or a carriage return starts with ' (the OWASP rule), so a spreadsheet runs no formula.",
    },
    { flag: "--after <id>", says: "Start after this id. The cursor of the page before gives it." },
    {
      flag: "--limit <n>",
      says: `The rows of one page, from 1 to ${PAGE_MAX}. The default is ${PAGE_MAX}.`,
    },
    {
      flag: "--max-calls <n>",
      says: `The most calls of one run, from 1 to ${MAX_CALLS_MAX}. The default is ${DEFAULT_MAX_CALLS}.`,
    },
    ...OPERATOR_FLAGS,
    { flag: "-h, --help", says: "Print this help. The command ignores every other argument." },
  ],
  exits: [
    { code: 0, says: "The command wrote every row." },
    PAGE_CUT_EXIT,
    { code: 2, says: toolStop("audit") },
  ],
  notes: [
    `The CSV columns are ${AUDIT_CSV_COLUMNS.join(", ")}. The data cell holds JSON text.`,
    "The command takes no --json, because stdout holds the export.",
    `Each run writes this line to stderr: ${EXPORT_NOTE}.`,
  ],
};
