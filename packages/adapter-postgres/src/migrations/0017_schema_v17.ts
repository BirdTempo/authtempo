/**
 * authtempo schema version 17 for Postgres: the enterprise setup (plan 13a).
 * Append-only: never edit a shipped migration. ta_sso_connection gets draft,
 * version, and setup_link_id. ta_sso_domain gets setup_link_id. ta_scim_token
 * gets pending and setup_link_id. draft and pending are NOT NULL with the
 * default false, and version is NOT NULL with the default 1. So a row of
 * version 16 reads as no draft, at version 1, with no setup link, and not
 * pending. A row that a writer of version 16 makes after this file reads the
 * same. Core writes every field, so these defaults live in this file only.
 * Three new tables hold the setup links, the test runs, and the setup
 * sessions. No new table has a user_id column: an IT admin has no account,
 * and a link can name an app as its maker. The runner applies the text in one
 * transaction. The columns keep the field order of the schema.
 */
export const name = "0017_schema_v17";
export const sql = `
ALTER TABLE ta_sso_connection ADD COLUMN draft boolean NOT NULL DEFAULT false;
ALTER TABLE ta_sso_connection ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_sso_connection ADD COLUMN setup_link_id text;
ALTER TABLE ta_sso_domain ADD COLUMN setup_link_id text;
ALTER TABLE ta_scim_token ADD COLUMN pending boolean NOT NULL DEFAULT false;
ALTER TABLE ta_scim_token ADD COLUMN setup_link_id text;
CREATE TABLE ta_sso_setup_link (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  steps jsonb NOT NULL,
  kinds jsonb NOT NULL,
  note text NOT NULL,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ended_at timestamptz,
  opened_at timestamptz,
  ready_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_sso_setup_link__token_hash ON ta_sso_setup_link (token_hash);
CREATE INDEX ix_ta_sso_setup_link__organization_id ON ta_sso_setup_link (organization_id);
CREATE TABLE ta_sso_test_run (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  connection_id text NOT NULL,
  link_id text,
  outcome text NOT NULL,
  step text,
  attribute_names jsonb NOT NULL,
  domain_claimed boolean NOT NULL,
  draft_version integer NOT NULL
);
CREATE INDEX ix_ta_sso_test_run__connection_id ON ta_sso_test_run (connection_id);
CREATE TABLE ta_sso_setup_session (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  link_id text NOT NULL,
  organization_id text NOT NULL,
  token_hash text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_sso_setup_session__token_hash ON ta_sso_setup_session (token_hash);
CREATE INDEX ix_ta_sso_setup_session__link_id ON ta_sso_setup_session (link_id);

UPDATE ta_meta SET value = '17' WHERE key = 'schema_version';
`;
