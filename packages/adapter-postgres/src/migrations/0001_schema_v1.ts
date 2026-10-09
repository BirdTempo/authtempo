/**
 * tempo-auth schema version 1 for Postgres. Append-only: never edit a
 * shipped migration; add 0002_... for the next version. No explicit schema
 * name, so it runs in whatever search_path the connection has.
 * Names come from @tempo-auth/core/sql: tables ta_<model>, columns snake_case,
 * unique indexes ux_<table>__<col>__<col>, indexes ix_<table>__<col>.
 */
export const name = "0001_schema_v1";
export const sql = `
CREATE TABLE ta_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO ta_meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE ta_user (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL,
  name text,
  image text
);
CREATE UNIQUE INDEX ux_ta_user__email ON ta_user (email);

CREATE TABLE ta_identity (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL,
  subject text NOT NULL,
  linked_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ux_ta_identity__provider__subject ON ta_identity (provider, subject);
CREATE INDEX ix_ta_identity__user_id ON ta_identity (user_id);

CREATE TABLE ta_session (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ip text,
  user_agent text,
  active_organization_id text
);
CREATE UNIQUE INDEX ux_ta_session__token_hash ON ta_session (token_hash);
CREATE INDEX ix_ta_session__user_id ON ta_session (user_id);

CREATE TABLE ta_verification (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  purpose text NOT NULL,
  identifier text NOT NULL,
  value_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  data jsonb
);
CREATE UNIQUE INDEX ux_ta_verification__value_hash ON ta_verification (value_hash);
CREATE INDEX ix_ta_verification__purpose__identifier ON ta_verification (purpose, identifier);

CREATE TABLE ta_passkey (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  credential_id text NOT NULL,
  public_key text NOT NULL,
  counter integer NOT NULL,
  transports text,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  name text
);
CREATE UNIQUE INDEX ux_ta_passkey__credential_id ON ta_passkey (credential_id);
CREATE INDEX ix_ta_passkey__user_id ON ta_passkey (user_id);
`;
