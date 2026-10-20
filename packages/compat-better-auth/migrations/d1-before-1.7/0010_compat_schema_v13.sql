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
-- createdAt, and adds the unique key on (teamId, userId). This is the file
-- for team tables from before Better Auth 1.7. Such tables have no
-- team.memberCount and no teamMember.membershipKey. The file creates absent
-- tables in the 1.4.21 form and then adds both columns: memberCount with
-- default 0, and membershipKey with a unique index. On the team tables of
-- 1.7 it stops with duplicate column name: memberCount. The text of the
-- default naming (camel case). Another naming: run
-- compatMigration0010Sql("sqlite", resolveNames(options), "before-1.7")
-- for its text.
-- ta_api_token and ta_organization_token are core's own token tables
-- (plan 12k Task 12), and ta_moved_token records each moved apikey row.
-- The file creates them with core's names. Better Auth's
-- apikey table stays as it is: no migration writes it or drops it.
ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT;
CREATE TABLE IF NOT EXISTS "organizationRole" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" date not null, "updatedAt" date);
CREATE INDEX IF NOT EXISTS "organizationRole_organizationId_idx" ON "organizationRole" ("organizationId");
CREATE INDEX IF NOT EXISTS "organizationRole_role_idx" ON "organizationRole" ("role");
ALTER TABLE "organizationRole" ADD COLUMN "taRank" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX ux_organization_role__organization_id__role ON "organizationRole" ("organizationId", "role");
CREATE TABLE IF NOT EXISTS "team" ("id" text not null primary key, "name" text not null, "organizationId" text not null references "organization" ("id") on delete cascade, "createdAt" date not null, "updatedAt" date);
CREATE TABLE IF NOT EXISTS "teamMember" ("id" text not null primary key, "teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "createdAt" date);
CREATE INDEX IF NOT EXISTS "team_organizationId_idx" ON "team" ("organizationId");
CREATE INDEX IF NOT EXISTS "teamMember_teamId_idx" ON "teamMember" ("teamId");
CREATE INDEX IF NOT EXISTS "teamMember_userId_idx" ON "teamMember" ("userId");
ALTER TABLE "team" ADD COLUMN "memberCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "teamMember" ADD COLUMN "membershipKey" TEXT;
CREATE UNIQUE INDEX ux_team_member__membership_key ON "teamMember" ("membershipKey");
ALTER TABLE "teamMember" ADD COLUMN "taOrganizationId" TEXT;
ALTER TABLE "teamMember" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "teamMember" SET "taOrganizationId" = (SELECT "organizationId" FROM "team" WHERE "team"."id" = "teamMember"."teamId") WHERE "taOrganizationId" IS NULL;
UPDATE "teamMember" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt") WHERE "taUpdatedAt" IS NULL;
CREATE UNIQUE INDEX ux_team_member__team_id__user_id ON "teamMember" ("teamId", "userId");
CREATE INDEX ix_team_member__ta_organization_id__user_id ON "teamMember" ("taOrganizationId", "userId");
CREATE TABLE ta_api_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  organization_id TEXT,
  permissions TEXT,
  metadata TEXT,
  rate_limit_seconds INTEGER,
  rate_limit_max INTEGER,
  remaining INTEGER,
  refill_amount INTEGER,
  refill_seconds INTEGER,
  last_refill_at INTEGER,
  retired_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_api_token__token_hash ON ta_api_token (token_hash);
CREATE INDEX ix_ta_api_token__user_id ON ta_api_token (user_id);
CREATE TABLE ta_organization_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  permissions TEXT NOT NULL,
  metadata TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  rate_limit_seconds INTEGER,
  rate_limit_max INTEGER,
  remaining INTEGER,
  refill_amount INTEGER,
  refill_seconds INTEGER,
  last_refill_at INTEGER,
  retired_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_organization_token__token_hash ON ta_organization_token (token_hash);
CREATE INDEX ix_ta_organization_token__organization_id ON ta_organization_token (organization_id);
CREATE TABLE ta_moved_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  token_id TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_moved_token__source__source_id ON ta_moved_token (source, source_id);
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '10' WHERE key = 'compat_better_auth';
