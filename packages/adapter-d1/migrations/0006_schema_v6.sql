-- tempo-auth schema version 6 for D1 (SQLite): the TOTP second factor
-- (plan 9f). Append-only: never edit a shipped migration.
-- ta_totp holds one row per user: the sealed secret, never the secret, the
-- last accepted 30-second step, and the keyed hashes of the backup codes as
-- JSON text. ta_trusted_device holds the SHA-256 hex of a trust token, never
-- the token. Dates are INTEGER epoch milliseconds. The columns keep the
-- field order of the schema.
CREATE TABLE ta_totp (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled_at INTEGER,
  last_step INTEGER NOT NULL,
  backup_codes TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_totp__user_id ON ta_totp (user_id);
CREATE TABLE ta_trusted_device (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_trusted_device__token_hash ON ta_trusted_device (token_hash);
CREATE INDEX ix_ta_trusted_device__user_id ON ta_trusted_device (user_id);

UPDATE ta_meta SET value = '6' WHERE key = 'schema_version';
