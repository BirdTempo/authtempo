-- tempo-auth schema version 7 for D1 (SQLite): JWT signing keys and the
-- OAuth 2.1 and OIDC provider (plan 9g). Append-only: never edit a shipped
-- migration. ta_jwk holds the signing keys: the public JWK as JSON text and
-- the sealed private key, never the clear key. The unique index on slot
-- keeps one signing key; a retired key has slot NULL, and NULLs never
-- conflict. ta_oauth_client holds the registered and the CIMD clients,
-- ta_oauth_consent one row per user and client, and ta_oauth_token the
-- SHA-256 hex of each refresh token, never the token. Dates are INTEGER
-- epoch milliseconds. The columns keep the field order of the schema.
CREATE TABLE ta_jwk (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  public_jwk TEXT NOT NULL,
  private_key TEXT NOT NULL,
  slot TEXT,
  retired_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_jwk__slot ON ta_jwk (slot);
CREATE TABLE ta_oauth_client (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  redirect_uris TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE ta_oauth_consent (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_consent__user_id__client_id ON ta_oauth_consent (user_id, client_id);
CREATE TABLE ta_oauth_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_oauth_token__token_hash ON ta_oauth_token (token_hash);
CREATE INDEX ix_ta_oauth_token__user_id ON ta_oauth_token (user_id);
CREATE INDEX ix_ta_oauth_token__family_id ON ta_oauth_token (family_id);

UPDATE ta_meta SET value = '7' WHERE key = 'schema_version';
