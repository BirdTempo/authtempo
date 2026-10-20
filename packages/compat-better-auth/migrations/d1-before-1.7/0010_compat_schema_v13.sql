-- authtempo compat migration 0010 (plan 12k): core schema version 13.
-- Append-only once it ships. Better Auth's teams option keeps activeTeamId
-- on session and teamId on invitation, which core reads as activeTeamId and
-- teamIds. Each is nullable, with no fill. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so on tables that hold these columns the file stops at the first
-- statement: such an app runs this file without its first two statements.
-- organizationRole is Better Auth's dynamicAccessControl table: the file
-- creates it with Better Auth's own DDL when it is absent, then adds taRank
-- and the unique key on (organizationId, role). The tables team and
-- teamMember belong to Better Auth's teams option. The file creates them
-- with Better Auth's own DDL when they are absent. Then it adds teamMember's
-- taOrganizationId and taUpdatedAt, fills them from the team and from
-- createdAt, and adds the unique key on (teamId, userId). The text of the
-- default naming (camel case). Another naming: run
-- compatMigration0010Sql("sqlite", resolveNames(options)) for its text.
ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;
CREATE TABLE IF NOT EXISTS "organizationRole" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" date not null, "updatedAt" date);
CREATE INDEX IF NOT EXISTS "organizationRole_organizationId_idx" ON "organizationRole" ("organizationId");
CREATE INDEX IF NOT EXISTS "organizationRole_role_idx" ON "organizationRole" ("role");
ALTER TABLE "organizationRole" ADD COLUMN "taRank" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX ux_organization_role__organization_id__role ON "organizationRole" ("organizationId", "role");
CREATE TABLE IF NOT EXISTS "team" ("id" text not null primary key, "name" text not null, "memberCount" integer not null, "organizationId" text not null references "organization" ("id") on delete cascade, "createdAt" date not null, "updatedAt" date);
CREATE TABLE IF NOT EXISTS "teamMember" ("id" text not null primary key, "teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "membershipKey" text unique, "createdAt" date);
CREATE INDEX IF NOT EXISTS "team_organizationId_idx" ON "team" ("organizationId");
CREATE INDEX IF NOT EXISTS "teamMember_teamId_idx" ON "teamMember" ("teamId");
CREATE INDEX IF NOT EXISTS "teamMember_userId_idx" ON "teamMember" ("userId");
ALTER TABLE "teamMember" ADD COLUMN "taOrganizationId" TEXT;
ALTER TABLE "teamMember" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "teamMember" SET "taOrganizationId" = (SELECT "organizationId" FROM "team" WHERE "team"."id" = "teamMember"."teamId") WHERE "taOrganizationId" IS NULL;
UPDATE "teamMember" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt") WHERE "taUpdatedAt" IS NULL;
CREATE UNIQUE INDEX ux_team_member__team_id__user_id ON "teamMember" ("teamId", "userId");
CREATE INDEX ix_team_member__ta_organization_id__user_id ON "teamMember" ("taOrganizationId", "userId");
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '10' WHERE key = 'compat_better_auth';
