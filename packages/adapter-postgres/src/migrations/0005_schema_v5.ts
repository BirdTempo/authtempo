/**
 * tempo-auth schema version 5 for Postgres: API tokens. Append-only: never
 * edit a shipped migration. One row per token. The table holds the SHA-256
 * hex of the token, never the token. The table name is ta_ plus the model
 * name in snake case. The columns keep the field order of the schema.
 */
export const name = "0005_schema_v5";
export const sql = `
CREATE TABLE ta_api_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  organization_id text
);
CREATE UNIQUE INDEX ux_ta_api_token__token_hash ON ta_api_token (token_hash);
CREATE INDEX ix_ta_api_token__user_id ON ta_api_token (user_id);

UPDATE ta_meta SET value = '5' WHERE key = 'schema_version';
`;
