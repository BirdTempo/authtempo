/**
 * tempo-auth schema version 6 for Postgres: the TOTP second factor (plan
 * 9f). Append-only: never edit a shipped migration. ta_totp holds one row
 * per user: the sealed secret, never the secret, the last accepted
 * 30-second step, and the keyed hashes of the backup codes. ta_trusted_device
 * holds the SHA-256 hex of a trust token, never the token. The columns keep
 * the field order of the schema.
 */
export const name = "0006_schema_v6";
export const sql = `
CREATE TABLE ta_totp (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  secret text NOT NULL,
  enabled_at timestamptz,
  last_step bigint NOT NULL,
  backup_codes jsonb NOT NULL
);
CREATE UNIQUE INDEX ux_ta_totp__user_id ON ta_totp (user_id);
CREATE TABLE ta_trusted_device (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ux_ta_trusted_device__token_hash ON ta_trusted_device (token_hash);
CREATE INDEX ix_ta_trusted_device__user_id ON ta_trusted_device (user_id);

UPDATE ta_meta SET value = '6' WHERE key = 'schema_version';
`;
