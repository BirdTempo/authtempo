ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "activeTeamId" text;
ALTER TABLE "invitation" ADD COLUMN IF NOT EXISTS "teamId" text;
CREATE TABLE IF NOT EXISTS "organizationRole" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz);
CREATE INDEX IF NOT EXISTS "organizationRole_organizationId_idx" ON "organizationRole" ("organizationId");
CREATE INDEX IF NOT EXISTS "organizationRole_role_idx" ON "organizationRole" ("role");
ALTER TABLE "organizationRole" ADD COLUMN IF NOT EXISTS "taRank" integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_organization_role__organization_id__role ON "organizationRole" ("organizationId", "role");
CREATE TABLE IF NOT EXISTS "team" ("id" text not null primary key, "name" text not null, "memberCount" integer not null, "organizationId" text not null references "organization" ("id") on delete cascade, "createdAt" timestamptz not null, "updatedAt" timestamptz);
CREATE TABLE IF NOT EXISTS "teamMember" ("id" text not null primary key, "teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "membershipKey" text unique, "createdAt" timestamptz);
CREATE INDEX IF NOT EXISTS "team_organizationId_idx" ON "team" ("organizationId");
CREATE INDEX IF NOT EXISTS "teamMember_teamId_idx" ON "teamMember" ("teamId");
CREATE INDEX IF NOT EXISTS "teamMember_userId_idx" ON "teamMember" ("userId");
ALTER TABLE "team" ADD COLUMN IF NOT EXISTS "memberCount" integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'teamMember' AND column_name = 'membershipKey') THEN
    ALTER TABLE "teamMember" ADD COLUMN "membershipKey" text;
    CREATE UNIQUE INDEX ux_team_member__membership_key ON "teamMember" ("membershipKey");
  END IF;
END $$;
ALTER TABLE "teamMember" ADD COLUMN IF NOT EXISTS "taOrganizationId" text;
ALTER TABLE "teamMember" ADD COLUMN IF NOT EXISTS "taUpdatedAt" timestamptz;
UPDATE "teamMember" SET "taOrganizationId" = (SELECT "organizationId" FROM "team" WHERE "team"."id" = "teamMember"."teamId") WHERE "taOrganizationId" IS NULL;
UPDATE "teamMember" SET "taUpdatedAt" = date_trunc('milliseconds', "createdAt") WHERE "taUpdatedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_team_member__team_id__user_id ON "teamMember" ("teamId", "userId");
CREATE INDEX IF NOT EXISTS ix_team_member__ta_organization_id__user_id ON "teamMember" ("taOrganizationId", "userId");
CREATE TABLE ta_api_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  organization_id text,
  permissions jsonb,
  metadata jsonb,
  rate_limit_seconds integer,
  rate_limit_max integer,
  remaining integer,
  refill_amount integer,
  refill_seconds integer,
  last_refill_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_api_token__token_hash ON ta_api_token (token_hash);
CREATE INDEX ix_ta_api_token__user_id ON ta_api_token (user_id);
CREATE TABLE ta_organization_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  created_by_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  permissions jsonb NOT NULL,
  metadata jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  rate_limit_seconds integer,
  rate_limit_max integer,
  remaining integer,
  refill_amount integer,
  refill_seconds integer,
  last_refill_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_organization_token__token_hash ON ta_organization_token (token_hash);
CREATE INDEX ix_ta_organization_token__organization_id ON ta_organization_token (organization_id);
CREATE TABLE ta_moved_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  token_id text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_moved_token__source__source_id ON ta_moved_token (source, source_id);
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '10' WHERE key = 'compat_better_auth';
