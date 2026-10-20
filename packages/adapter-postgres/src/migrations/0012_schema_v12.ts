/**
 * authtempo schema version 12 for Postgres: the operator tools (plan 12f).
 * Append-only: never edit a shipped migration. ta_user gets the three ban
 * fields and ta_session gets actor_id, the operator of an impersonation.
 * Each new column is nullable with no default and no fill: a row of version
 * 11 holds NULL, which means no ban and no impersonation. ta_operator_audit
 * holds one row per operator act. It has no user_id column, so the account
 * delete keeps its rows. The columns keep the field order of the schema.
 */
export const name = "0012_schema_v12";
export const sql = `
ALTER TABLE ta_user ADD COLUMN banned_at timestamptz;
ALTER TABLE ta_user ADD COLUMN ban_reason text;
ALTER TABLE ta_user ADD COLUMN ban_until timestamptz;
ALTER TABLE ta_session ADD COLUMN actor_id text;
CREATE TABLE ta_operator_audit (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_user_id text,
  reason text NOT NULL,
  data jsonb,
  ip text,
  user_agent text
);
CREATE INDEX ix_ta_operator_audit__target_user_id ON ta_operator_audit (target_user_id);
CREATE INDEX ix_ta_operator_audit__actor_id ON ta_operator_audit (actor_id);

UPDATE ta_meta SET value = '12' WHERE key = 'schema_version';
`;
