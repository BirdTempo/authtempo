-- authtempo compat migration 0009 (plan 12f): core schema version 12.
-- Append-only. The ban of a user: taBannedAt, taBanReason, and taBanUntil.
-- The operator of an impersonation: taActorId on session. Each is nullable,
-- with no fill. ta_operator_audit is core's own table, as in core 0012.
-- The text of the default naming (camel case). Another naming: run
-- compatMigration0009Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE "user" ADD COLUMN "taBannedAt" TEXT;
ALTER TABLE "user" ADD COLUMN "taBanReason" TEXT;
ALTER TABLE "user" ADD COLUMN "taBanUntil" TEXT;
ALTER TABLE "session" ADD COLUMN "taActorId" TEXT;
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
UPDATE ta_meta SET value = '9' WHERE key = 'compat_better_auth';
