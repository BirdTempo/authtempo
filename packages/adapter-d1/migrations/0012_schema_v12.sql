-- authtempo schema version 12 for D1 (SQLite): the operator tools (plan
-- 12f). Append-only: never edit a shipped migration. ta_user gets the three
-- ban fields and ta_session gets actor_id, the operator of an impersonation.
-- Each new column is nullable with no default and no fill: a row of version
-- 11 holds NULL, which means no ban and no impersonation. ta_operator_audit
-- holds one row per operator act. It has no user_id column, so the account
-- delete keeps its rows. JSON is TEXT, and dates are INTEGER epoch
-- milliseconds. The columns keep the field order of the schema.
ALTER TABLE ta_user ADD COLUMN banned_at INTEGER;
ALTER TABLE ta_user ADD COLUMN ban_reason TEXT;
ALTER TABLE ta_user ADD COLUMN ban_until INTEGER;
ALTER TABLE ta_session ADD COLUMN actor_id TEXT;
CREATE TABLE ta_operator_audit (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  reason TEXT NOT NULL,
  data TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX ix_ta_operator_audit__target_user_id ON ta_operator_audit (target_user_id);
CREATE INDEX ix_ta_operator_audit__actor_id ON ta_operator_audit (actor_id);

UPDATE ta_meta SET value = '12' WHERE key = 'schema_version';
