/**
 * tempo-auth schema version 7 for Postgres: JWT signing keys and the OAuth
 * 2.1 and OIDC provider (plan 9g). Append-only: never edit a shipped
 * migration. ta_jwk holds the public JWK and the sealed private key, never
 * the clear key; the unique index on slot keeps one signing key, and a
 * retired key has slot NULL. ta_oauth_token holds the SHA-256 hex of each
 * refresh token, never the token. The columns keep the field order of the schema.
 */
export const name = "0007_schema_v7";
export const sql = `
CREATE TABLE ta_jwk (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  public_jwk jsonb NOT NULL,
  private_key text NOT NULL,
  slot text,
  retired_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_jwk__slot ON ta_jwk (slot);
CREATE TABLE ta_oauth_client (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  kind text NOT NULL,
  name text,
  redirect_uris jsonb NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE ta_oauth_consent (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_consent__client_id__user_id ON ta_oauth_consent (client_id, user_id);
CREATE INDEX ix_ta_oauth_consent__user_id ON ta_oauth_consent (user_id);
CREATE TABLE ta_oauth_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  token_hash text NOT NULL,
  family_id text NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_oauth_token__token_hash ON ta_oauth_token (token_hash);
CREATE INDEX ix_ta_oauth_token__user_id ON ta_oauth_token (user_id);
CREATE INDEX ix_ta_oauth_token__family_id ON ta_oauth_token (family_id);
CREATE INDEX ix_ta_oauth_token__client_id ON ta_oauth_token (client_id);

UPDATE ta_meta SET value = '7' WHERE key = 'schema_version';
`;
