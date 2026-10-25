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
  user_create: true,
  user_update: true,
  user_delete: true,
  // The actions of plan 12d (SSO_AUDIT_ACTIONS of the schema).
  sso_connection_create: true,
  sso_connection_update: true,
  sso_connection_delete: true,
  sso_domain_add: true,
  sso_domain_verify: true,
  sso_domain_update: true,
  sso_domain_delete: true,
  sso_domain_lost: true,
  sso_enforce_off: true,
  scim_token_create: true,
  scim_token_revoke: true,
  scim_user_create: true,
  scim_user_update: true,
  scim_user_deactivate: true,
  scim_user_delete: true,
  scim_group_create: true,
  scim_group_update: true,
  scim_group_delete: true,
};

export const OPERATOR_ACTIONS: readonly OperatorAction[] = Object.freeze(
  Object.keys(ACTIONS) as OperatorAction[],
);
