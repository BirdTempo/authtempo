-- tempo-auth schema version 5 for D1 (SQLite): API tokens. Append-only:
-- never edit a shipped migration.
-- One row per token. The table holds the SHA-256 hex of the token, never the
-- token. The table name is ta_ plus the model name in snake case. Dates are
-- INTEGER epoch milliseconds. The columns keep the field order of the schema.
CREATE TABLE ta_api_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  organization_id TEXT
);
CREATE UNIQUE INDEX ux_ta_api_token__token_hash ON ta_api_token (token_hash);
CREATE INDEX ix_ta_api_token__user_id ON ta_api_token (user_id);

UPDATE ta_meta SET value = '5' WHERE key = 'schema_version';
