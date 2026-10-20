/**
 * authtempo schema version 11 for Postgres: the OAuth provider, second
 * version (plan 12e). Append-only: never edit a shipped migration.
 * ta_oauth_client gets the fields of a confidential client, the grants, the
 * logout URIs, the subject type, and the DPoP flag. Each NOT NULL column has
 * a default, so each row of version 10 reads as the public client it was.
 * The defaults are here only: core writes every field on each insert.
 * Postgres 11 and later add a column with a constant default without a
 * rewrite of the table. The columns keep the field order of the schema. The
 * two new verification purposes need no DDL.
 */
export const name = "0011_schema_v11";
export const sql = `
ALTER TABLE ta_oauth_client ADD COLUMN auth_method text NOT NULL DEFAULT 'none';
ALTER TABLE ta_oauth_client ADD COLUMN secret_hash text;
ALTER TABLE ta_oauth_client ADD COLUMN secret_expires_at timestamptz;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_hash text;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_until timestamptz;
ALTER TABLE ta_oauth_client ADD COLUMN jwks jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN jwks_uri text;
ALTER TABLE ta_oauth_client ADD COLUMN grant_types jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN credentials_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN introspect boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_client ADD COLUMN post_logout_redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_uri text;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_session_required boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_client ADD COLUMN subject_type text NOT NULL DEFAULT 'public';
ALTER TABLE ta_oauth_client ADD COLUMN dpop_bound boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_token ADD COLUMN parent_id text;
ALTER TABLE ta_oauth_token ADD COLUMN dpop_jkt text;
CREATE INDEX ix_ta_oauth_token__parent_id ON ta_oauth_token (parent_id);
CREATE TABLE ta_oauth_device (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  device_code_hash text NOT NULL,
  user_code_hash text NOT NULL,
  secret_version integer NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  status text NOT NULL,
  user_id text,
  session_id text,
  interval integer NOT NULL,
  last_polled_at timestamptz,
  dpop_jkt text,
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_device__device_code_hash ON ta_oauth_device (device_code_hash);
CREATE UNIQUE INDEX ux_ta_oauth_device__user_code_hash ON ta_oauth_device (user_code_hash);
CREATE INDEX ix_ta_oauth_device__expires_at ON ta_oauth_device (expires_at);
CREATE TABLE ta_oauth_subject (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  sector text NOT NULL,
  subject text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_subject__sector__user_id ON ta_oauth_subject (sector, user_id);
CREATE UNIQUE INDEX ux_ta_oauth_subject__subject ON ta_oauth_subject (subject);
CREATE INDEX ix_ta_oauth_subject__user_id ON ta_oauth_subject (user_id);
CREATE TABLE ta_oauth_session_client (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  session_id text NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  sid text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_session_client__session_id__client_id ON ta_oauth_session_client (session_id, client_id);
CREATE INDEX ix_ta_oauth_session_client__user_id ON ta_oauth_session_client (user_id);
CREATE TABLE ta_oauth_logout (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL,
  sid text NOT NULL,
  attempts integer NOT NULL,
  next_attempt_at timestamptz NOT NULL
);
CREATE INDEX ix_ta_oauth_logout__next_attempt_at ON ta_oauth_logout (next_attempt_at);
CREATE INDEX ix_ta_oauth_logout__user_id ON ta_oauth_logout (user_id);

UPDATE ta_meta SET value = '11' WHERE key = 'schema_version';
`;
