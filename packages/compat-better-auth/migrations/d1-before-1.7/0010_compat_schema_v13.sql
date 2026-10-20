-- authtempo compat migration 0010 (plan 12k): core schema version 13.
-- Append-only once it ships. Better Auth's teams option keeps activeTeamId
-- on session and teamId on invitation, which core reads as activeTeamId and
-- teamIds. Each is nullable, with no fill. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so on tables that hold these columns the file stops at the first
-- statement. The text of the default naming (camel case). Another naming: run
-- compatMigration0010Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '10' WHERE key = 'compat_better_auth';
