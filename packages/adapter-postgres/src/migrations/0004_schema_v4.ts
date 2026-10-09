/**
 * tempo-auth schema version 4 for Postgres: passwords. Append-only: never
 * edit a shipped migration. One row per user. The hash names its algorithm
 * and its cost, so a later hash seam can rehash on sign-in.
 */
export const name = "0004_schema_v4";
export const sql = `
CREATE TABLE ta_password (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  hash text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_password__user_id ON ta_password (user_id);

UPDATE ta_meta SET value = '4' WHERE key = 'schema_version';
`;
