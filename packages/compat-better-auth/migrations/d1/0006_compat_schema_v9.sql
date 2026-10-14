-- authtempo compat migration 0006 (plan 12b): core schema version 9.
-- Append-only. The secret version of each sealed value and keyed hash.
-- The text of the default naming (camel case). Another naming: run
-- compatMigration0006Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE ta_totp ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_second_factor ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_jwk ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "verification" ADD COLUMN "taSecretVersion" INTEGER NOT NULL DEFAULT 1;
UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '6' WHERE key = 'compat_better_auth';
