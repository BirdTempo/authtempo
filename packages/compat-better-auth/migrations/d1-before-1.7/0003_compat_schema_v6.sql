-- tempo-auth compat migration 0003 (plan 9f): core schema version 6.
-- Append-only. Core 6 adds the TOTP second factor. Better Auth has no table
-- that fits it, so this file creates core's own ta_totp and
-- ta_trusted_device beside the Better Auth tables. Apply it after 0002 for
-- every naming and both variants: it names ta_ tables only.
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
UPDATE ta_meta SET value = '3' WHERE key = 'compat_better_auth';
