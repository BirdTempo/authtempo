-- authtempo compat migration 0013 (plan 12p): core schema version 16.
-- Append-only. Core 16 adds the proof mark of a session. Better Auth's
-- session table gets taProved, NOT NULL with the default 0, so a row that
-- Better Auth writes reads false. Then the fill sets 1 on each session whose
-- user has a verified address. A placeholder address of Better Auth reads as
-- no address, so its session keeps 0. A user with no address signs in again
-- for verified powers. A user with an unverified address proves it first.
-- The text of the default naming (camel case), the same for both variants.
-- Another naming: run compatMigration0013Sql("sqlite", resolveNames(options))
-- for its text.
ALTER TABLE "session" ADD COLUMN "taProved" INTEGER NOT NULL DEFAULT 0;
UPDATE "session" SET "taProved" = 1 WHERE "userId" IN (SELECT "id" FROM "user" WHERE "emailVerified" = 1 AND "email" IS NOT NULL AND NOT (lower("email") LIKE '%@placeholder.invalid' OR lower("email") LIKE '%.placeholder.invalid'));
UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '13' WHERE key = 'compat_better_auth';
