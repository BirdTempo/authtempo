-- tempo-auth compat migration 0004 (plan 9g): core schema version 7.
-- Append-only. Core 7 adds the signing keys and the OAuth provider. This
-- package maps no Better Auth jwt or OAuth plugin, so these tables stay
-- empty under it; they keep core's version gate. Apply it after 0003 for
-- every naming and both variants: it names ta_ tables only.
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
CREATE UNIQUE INDEX ux_ta_oauth_consent__client_id__user_id ON ta_oauth_consent (client_id, user_id);
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
CREATE INDEX ix_ta_oauth_token__client_id ON ta_oauth_token (client_id);
UPDATE ta_meta SET value = '7' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '4' WHERE key = 'compat_better_auth';
