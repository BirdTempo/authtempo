-- authtempo compat migration 0010 (plan 12k): core schema version 13.
-- Append-only once it ships. Better Auth's teams option keeps activeTeamId
-- on session and teamId on invitation, which core reads as activeTeamId and
-- teamIds. Each is nullable, with no fill. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so on tables that hold these columns the file stops at the first
-- statement: such an app runs this file without its first two statements.
-- organizationRole is Better Auth's dynamicAccessControl table: the file
-- creates it with Better Auth's own DDL when it is absent, then adds taRank
-- and the unique key on (organizationId, role). The text of the default
-- naming (camel case). Another naming: run
-- compatMigration0010Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;
CREATE TABLE IF NOT EXISTS "organizationRole" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" date not null, "updatedAt" date);
CREATE INDEX IF NOT EXISTS "organizationRole_organizationId_idx" ON "organizationRole" ("organizationId");
CREATE INDEX IF NOT EXISTS "organizationRole_role_idx" ON "organizationRole" ("role");
ALTER TABLE "organizationRole" ADD COLUMN "taRank" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX ux_organization_role__organization_id__role ON "organizationRole" ("organizationId", "role");
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '10' WHERE key = 'compat_better_auth';
