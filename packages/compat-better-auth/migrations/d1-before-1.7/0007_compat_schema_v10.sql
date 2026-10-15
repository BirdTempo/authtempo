-- authtempo compat migration 0007 (plan 12a): core schema version 10.
-- Append-only. The fresh time of a session: taFreshAt, nullable, no fill.
-- The text of the default naming (camel case). Another naming: run
-- compatMigration0007Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE "session" ADD COLUMN "taFreshAt" TEXT;
UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '7' WHERE key = 'compat_better_auth';
