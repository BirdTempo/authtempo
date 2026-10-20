import { COMMON_FLAGS, type HelpText } from "./types.js";
import { GROUP_EXITS, PAGE_FLAGS, READ_FLAGS, toolStop } from "./users.js";

export const AUDIT_HELP: HelpText = {
  command: "audit",
  page: "audit",
  purpose:
    "Read the audit rows of the operator acts of a deployment. Core writes one row for each act and changes no row.",
  usage: ["authtempo audit list <base url> [--user <id>] [--after <id>] [--limit <n>] [--all]"],
  examples: [
    {
      line: "authtempo audit list https://api.example.com",
      says: "List the first 50 audit rows.",
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
    "authtempo audit list <base url> [--user <id>] [--after <id>] [--limit <n>] [--all] [--token-env <NAME> | --token-file <path>]",
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
    { code: 2, says: toolStop("audit") },
  ],
};
