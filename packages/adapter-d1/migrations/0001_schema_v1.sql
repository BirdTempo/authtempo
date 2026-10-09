-- tempo-auth schema version 1 for D1 (SQLite). Append-only: never edit a
-- shipped migration; add 0002_... for the next version.
-- Dates are INTEGER epoch milliseconds. Booleans are INTEGER 0 or 1. JSON is TEXT.
-- Names come from @tempo-auth/core/sql: tables ta_<model>, columns snake_case,
-- unique indexes ux_<table>__<col>__<col>, indexes ix_<table>__<col>.

CREATE TABLE ta_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
INSERT INTO ta_meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE ta_user (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL,
  name TEXT,
  image TEXT
);
CREATE UNIQUE INDEX ux_ta_user__email ON ta_user (email);

CREATE TABLE ta_identity (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_identity__provider__subject ON ta_identity (provider, subject);
CREATE INDEX ix_ta_identity__user_id ON ta_identity (user_id);

CREATE TABLE ta_session (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  active_organization_id TEXT
);
CREATE UNIQUE INDEX ux_ta_session__token_hash ON ta_session (token_hash);
CREATE INDEX ix_ta_session__user_id ON ta_session (user_id);

CREATE TABLE ta_verification (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  identifier TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  data TEXT
);
CREATE UNIQUE INDEX ux_ta_verification__value_hash ON ta_verification (value_hash);
CREATE INDEX ix_ta_verification__purpose__identifier ON ta_verification (purpose, identifier);

CREATE TABLE ta_passkey (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  name TEXT
);
CREATE UNIQUE INDEX ux_ta_passkey__credential_id ON ta_passkey (credential_id);
CREATE INDEX ix_ta_passkey__user_id ON ta_passkey (user_id);
