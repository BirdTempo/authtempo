import type { OperatorAction } from "../../schema.js";

/**
 * Every action of an audit row (spec 26 item 8). A Record, so a value added
 * to `OperatorAction` and not listed here fails the compile. The file
 * imports types only, so the event table reads it with no import cycle
 * (plan 12h Task 6).
 */
const ACTIONS: Readonly<Record<OperatorAction, true>> = {
  ban: true,
  unban: true,
  platform_role_grant: true,
  platform_role_revoke: true,
  second_factor_disable: true,
  sessions_end_user: true,
  sessions_end_all: true,
  impersonation_start: true,
  impersonation_stop: true,
  create_admin: true,
};

export const OPERATOR_ACTIONS: readonly OperatorAction[] = Object.freeze(
  Object.keys(ACTIONS) as OperatorAction[],
);
