import { ROOT_HELP } from "./authtempo.js";
import { CHECK_HELP } from "./check.js";
import { IMPORT_HELP } from "./import.js";
import { INFO_HELP } from "./info.js";
import { INIT_HELP } from "./init.js";
import { KEYS_HELP } from "./keys.js";
import { MCP_HELP } from "./mcp.js";
import { MIGRATE_HELP } from "./migrate.js";
import { SECRET_HELP, SECRET_REWRAP_HELP, SECRET_STATUS_HELP } from "./secret.js";
import type { HelpText } from "./types.js";

/**
 * Every help text: the program, then each command in the order of the table
 * in main.ts, and each subcommand after its command (plan 11c2). The docs
 * site reads this list (plan 11c Task 9); the common test holds it to the
 * table.
 */
export const HELP: readonly HelpText[] = [
  ROOT_HELP,
  INIT_HELP,
  MIGRATE_HELP,
  IMPORT_HELP,
  CHECK_HELP,
  KEYS_HELP,
  MCP_HELP,
  SECRET_HELP,
  SECRET_STATUS_HELP,
  SECRET_REWRAP_HELP,
  INFO_HELP,
];
