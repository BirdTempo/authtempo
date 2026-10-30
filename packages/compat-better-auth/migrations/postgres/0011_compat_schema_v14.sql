CREATE TABLE ta_sso_connection (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL,
  jit boolean NOT NULL,
  default_role text NOT NULL,
  config jsonb NOT NULL,
  client_secret text,
  secret_version integer NOT NULL,
  mfa jsonb,
  scim_roles jsonb
);
CREATE INDEX ix_ta_sso_connection__organization_id ON ta_sso_connection (organization_id);
CREATE TABLE ta_sso_domain (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  domain text NOT NULL,
  challenge text NOT NULL,
  claimed_domain text,
  connection_id text,
  enforce boolean NOT NULL,
  include_subdomains boolean NOT NULL,
  verified_at timestamptz,
  checked_at timestamptz,
  failures integer NOT NULL,
  first_failure_at timestamptz,
  expires_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_sso_domain__organization_id__domain ON ta_sso_domain (organization_id, domain);
CREATE UNIQUE INDEX ux_ta_sso_domain__claimed_domain ON ta_sso_domain (claimed_domain);
CREATE INDEX ix_ta_sso_domain__connection_id ON ta_sso_domain (connection_id);
CREATE TABLE ta_scim_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_scim_token__token_hash ON ta_scim_token (token_hash);
CREATE INDEX ix_ta_scim_token__organization_id ON ta_scim_token (organization_id);
CREATE TABLE ta_scim_user (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  user_name text NOT NULL,
  user_name_key text NOT NULL,
  external_id text,
  active boolean NOT NULL,
  display_name text,
  data jsonb NOT NULL,
  version integer NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_user__organization_id__user_id ON ta_scim_user (organization_id, user_id);
CREATE UNIQUE INDEX ux_ta_scim_user__organization_id__user_name_key ON ta_scim_user (organization_id, user_name_key);
CREATE INDEX ix_ta_scim_user__organization_id__external_id ON ta_scim_user (organization_id, external_id);
CREATE TABLE ta_scim_group (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  display_name text NOT NULL,
  display_name_key text NOT NULL,
  external_id text,
  team_id text,
  version integer NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_group__organization_id__display_name_key ON ta_scim_group (organization_id, display_name_key);
CREATE INDEX ix_ta_scim_group__organization_id__external_id ON ta_scim_group (organization_id, external_id);
CREATE TABLE ta_scim_group_member (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  group_id text NOT NULL,
  scim_user_id text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_scim_group_member__group_id__scim_user_id ON ta_scim_group_member (group_id, scim_user_id);
CREATE INDEX ix_ta_scim_group_member__scim_user_id ON ta_scim_group_member (scim_user_id);
UPDATE ta_meta SET value = '14' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '11' WHERE key = 'compat_better_auth';
