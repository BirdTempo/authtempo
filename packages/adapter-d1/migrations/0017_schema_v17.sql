-- authtempo schema version 17 for D1 (SQLite): the enterprise setup (plan
-- 13a). Append-only: never edit a shipped migration. ta_sso_connection gets
-- draft, version, and setup_link_id. ta_sso_domain gets setup_link_id.
-- ta_scim_token gets pending and setup_link_id. draft and pending are NOT
-- NULL with the default 0, and version is NOT NULL with the default 1. So a
-- row of version 16 reads as no draft, at version 1, with no setup link, and
-- not pending. A row that a Worker of version 16 writes after this file reads
-- the same. Core writes every field, so these defaults live in this file only.
-- Three new tables hold the setup links, the test runs, and the setup
-- sessions. No new table has a user_id column: an IT admin has no account,
-- and a link can name an app as its maker. Booleans are INTEGER, JSON is
-- TEXT, and dates are INTEGER epoch milliseconds. The columns keep the field
-- order of the schema.
ALTER TABLE ta_sso_connection ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_sso_connection ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_sso_connection ADD COLUMN setup_link_id TEXT;
ALTER TABLE ta_sso_domain ADD COLUMN setup_link_id TEXT;
ALTER TABLE ta_scim_token ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_scim_token ADD COLUMN setup_link_id TEXT;
CREATE TABLE ta_sso_setup_link (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  steps TEXT NOT NULL,
  kinds TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ended_at INTEGER,
  opened_at INTEGER,
  ready_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_sso_setup_link__token_hash ON ta_sso_setup_link (token_hash);
CREATE INDEX ix_ta_sso_setup_link__organization_id ON ta_sso_setup_link (organization_id);
CREATE TABLE ta_sso_test_run (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  link_id TEXT,
  outcome TEXT NOT NULL,
  step TEXT,
  attribute_names TEXT NOT NULL,
  domain_claimed INTEGER NOT NULL,
  draft_version INTEGER NOT NULL
);
CREATE INDEX ix_ta_sso_test_run__connection_id ON ta_sso_test_run (connection_id);
CREATE TABLE ta_sso_setup_session (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  link_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_sso_setup_session__token_hash ON ta_sso_setup_session (token_hash);
CREATE INDEX ix_ta_sso_setup_session__link_id ON ta_sso_setup_session (link_id);

UPDATE ta_meta SET value = '17' WHERE key = 'schema_version';
