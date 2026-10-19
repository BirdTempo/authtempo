-- authtempo schema version 11 for D1 (SQLite): the OAuth provider, second
-- version (plan 12e). Append-only: never edit a shipped migration.
-- ta_oauth_client gets the fields of a confidential client, the grants, the
-- logout URIs, the subject type, and the DPoP flag. Each NOT NULL column has
-- a default, so each row of version 10 reads as the public client it was.
-- That client has the auth method none and the grants authorization_code and
-- refresh_token. It has no secret, no key set, and no DPoP binding, and its
-- subjects are public. The defaults are here only: core writes every field
-- on each insert. Booleans are INTEGER 0
-- or 1, JSON is TEXT, and dates are INTEGER epoch milliseconds. The columns
-- keep the field order of the schema. The two new verification purposes
-- need no DDL: purpose is a text column.
ALTER TABLE ta_oauth_client ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE ta_oauth_client ADD COLUMN secret_hash TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN secret_expires_at INTEGER;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_hash TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_until INTEGER;
ALTER TABLE ta_oauth_client ADD COLUMN jwks TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN jwks_uri TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]';
ALTER TABLE ta_oauth_client ADD COLUMN credentials_scopes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ta_oauth_client ADD COLUMN introspect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_client ADD COLUMN post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_uri TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_session_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_client ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'public';
ALTER TABLE ta_oauth_client ADD COLUMN dpop_bound INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_token ADD COLUMN parent_id TEXT;
ALTER TABLE ta_oauth_token ADD COLUMN dpop_jkt TEXT;
CREATE INDEX ix_ta_oauth_token__parent_id ON ta_oauth_token (parent_id);
CREATE TABLE ta_oauth_device (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_code_hash TEXT NOT NULL,
  user_code_hash TEXT NOT NULL,
  secret_version INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  interval INTEGER NOT NULL,
  last_polled_at INTEGER,
  dpop_jkt TEXT,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_device__device_code_hash ON ta_oauth_device (device_code_hash);
CREATE UNIQUE INDEX ux_ta_oauth_device__user_code_hash ON ta_oauth_device (user_code_hash);
CREATE INDEX ix_ta_oauth_device__expires_at ON ta_oauth_device (expires_at);
CREATE TABLE ta_oauth_subject (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  sector TEXT NOT NULL,
  subject TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_subject__sector__user_id ON ta_oauth_subject (sector, user_id);
CREATE UNIQUE INDEX ux_ta_oauth_subject__subject ON ta_oauth_subject (subject);
CREATE INDEX ix_ta_oauth_subject__user_id ON ta_oauth_subject (user_id);
CREATE TABLE ta_oauth_session_client (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_session_client__session_id__client_id ON ta_oauth_session_client (session_id, client_id);
CREATE INDEX ix_ta_oauth_session_client__user_id ON ta_oauth_session_client (user_id);
CREATE TABLE ta_oauth_logout (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL
);
CREATE INDEX ix_ta_oauth_logout__next_attempt_at ON ta_oauth_logout (next_attempt_at);
CREATE INDEX ix_ta_oauth_logout__user_id ON ta_oauth_logout (user_id);

UPDATE ta_meta SET value = '11' WHERE key = 'schema_version';
