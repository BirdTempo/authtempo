import { AUDIT_HELP, AUDIT_LIST_HELP } from "./audit.js";
import { ROOT_HELP } from "./authtempo.js";
import { CHECK_HELP } from "./check.js";
import { CREATE_ADMIN_HELP } from "./create-admin.js";
import { GENERATE_HELP } from "./generate.js";
import { IMPORT_HELP } from "./import.js";
import { INFO_HELP } from "./info.js";
import { INIT_HELP } from "./init.js";
import { KEYS_HELP } from "./keys.js";
import { MCP_HELP } from "./mcp.js";
import { MIGRATE_HELP } from "./migrate.js";
import { SECRET_HELP, SECRET_REWRAP_HELP, SECRET_STATUS_HELP } from "./secret.js";
import { SESSIONS_END_ALL_HELP, SESSIONS_END_HELP, SESSIONS_HELP } from "./sessions.js";
import type { HelpText } from "./types.js";
import { UPGRADE_HELP } from "./upgrade.js";
import {
  USERS_BAN_HELP,
  USERS_CREATE_HELP,
  USERS_DELETE_HELP,
  USERS_GET_HELP,
  USERS_HELP,
  USERS_LIST_HELP,
  USERS_PLATFORM_ROLE_HELP,
  USERS_SEARCH_HELP,
  USERS_SECOND_FACTOR_OFF_HELP,
  USERS_UNBAN_HELP,
  USERS_UPDATE_HELP,
} from "./users.js";

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
  USERS_HELP,
  USERS_LIST_HELP,
  USERS_SEARCH_HELP,
  USERS_GET_HELP,
  USERS_BAN_HELP,
  USERS_UNBAN_HELP,
  USERS_PLATFORM_ROLE_HELP,
  USERS_SECOND_FACTOR_OFF_HELP,
  USERS_CREATE_HELP,
  USERS_UPDATE_HELP,
  USERS_DELETE_HELP,
  SESSIONS_HELP,
  SESSIONS_END_HELP,
  SESSIONS_END_ALL_HELP,
  AUDIT_HELP,
  AUDIT_LIST_HELP,
  CREATE_ADMIN_HELP,
  GENERATE_HELP,
  UPGRADE_HELP,
];
