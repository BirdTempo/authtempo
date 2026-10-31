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
UPDATE ta_meta SET value = '4' WHERE key = 'compat_better_auth';
