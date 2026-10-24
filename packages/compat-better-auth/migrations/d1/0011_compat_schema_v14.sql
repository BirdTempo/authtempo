-- authtempo compat migration 0011 (plan 12d): core schema version 14.
-- Append-only. Core 14 adds six tables of core beside the Better Auth
-- tables: the IdP connections, the claimed email domains, the SCIM tokens,
-- the SCIM users, the SCIM groups, and the group members. Better Auth's
-- ssoProvider table and the tables of its SCIM plugin stay as they are: no
-- migration reads, writes, or drops them. Apply it after 0010 for every
-- naming and both variants: it names ta_ tables only.
CREATE TABLE ta_sso_connection (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  jit INTEGER NOT NULL,
  default_role TEXT NOT NULL,
  config TEXT NOT NULL,
  client_secret TEXT,
  secret_version INTEGER NOT NULL,
  mfa TEXT,
  scim_roles TEXT
);
CREATE INDEX ix_ta_sso_connection__organization_id ON ta_sso_connection (organization_id);
CREATE TABLE ta_sso_domain (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  challenge TEXT NOT NULL,
  claimed_domain TEXT,
  connection_id TEXT,
  enforce INTEGER NOT NULL,
  include_subdomains INTEGER NOT NULL,
  verified_at INTEGER,
  checked_at INTEGER,
  failures INTEGER NOT NULL,
  first_failure_at INTEGER,
  expires_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_sso_domain__organization_id__domain ON ta_sso_domain (organization_id, domain);
CREATE UNIQUE INDEX ux_ta_sso_domain__claimed_domain ON ta_sso_domain (claimed_domain);
CREATE INDEX ix_ta_sso_domain__connection_id ON ta_sso_domain (connection_id);
CREATE TABLE ta_scim_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_scim_token__token_hash ON ta_scim_token (token_hash);
CREATE INDEX ix_ta_scim_token__organization_id ON ta_scim_token (organization_id);
CREATE TABLE ta_scim_user (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_name_key TEXT NOT NULL,
  external_id TEXT,
  active INTEGER NOT NULL,
  display_name TEXT,
  data TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_user__organization_id__user_id ON ta_scim_user (organization_id, user_id);
CREATE UNIQUE INDEX ux_ta_scim_user__organization_id__user_name_key ON ta_scim_user (organization_id, user_name_key);
CREATE INDEX ix_ta_scim_user__organization_id__external_id ON ta_scim_user (organization_id, external_id);
CREATE TABLE ta_scim_group (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_name_key TEXT NOT NULL,
  external_id TEXT,
  team_id TEXT,
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_group__organization_id__display_name_key ON ta_scim_group (organization_id, display_name_key);
CREATE INDEX ix_ta_scim_group__organization_id__external_id ON ta_scim_group (organization_id, external_id);
CREATE TABLE ta_scim_group_member (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  scim_user_id TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_group_member__group_id__scim_user_id ON ta_scim_group_member (group_id, scim_user_id);
CREATE INDEX ix_ta_scim_group_member__scim_user_id ON ta_scim_group_member (scim_user_id);
UPDATE ta_meta SET value = '14' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '11' WHERE key = 'compat_better_auth';
