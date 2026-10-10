-- tempo-auth compat 0001 for D1 (SQLite): tempo-auth on the Better Auth 1.7 tables.
-- Append-only: never edit this file. The text is compatMigrationSql("sqlite",
-- resolveNames()), with Better Auth's default names (camelCase, singular
-- tables). An app with other names writes its own file from
-- compatMigrationSql("sqlite", resolveNames({ ... })).
-- It adds two tables (ta_limit, ta_meta), nullable ta columns, and unique keys.
-- The Better Auth tables must exist first, with the issuer column of 1.7 and its
-- unique index. Tables from before 1.7: use migrations/d1-before-1.7 instead.
CREATE TABLE ta_limit (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
UPDATE "account" SET "issuer" = CASE "providerId" WHEN 'credential' THEN 'local:credential' WHEN 'email' THEN 'local:email' WHEN 'google' THEN 'https://accounts.google.com' WHEN 'apple' THEN 'https://appleid.apple.com' ELSE 'local:oauth:' || "providerId" END WHERE "issuer" IS NULL;
UPDATE "passkey" SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "createdAt" IS NULL;
CREATE INDEX ix_ta_limit__expires_at ON ta_limit (expires_at);
ALTER TABLE "account" ADD COLUMN "taLinkedAt" TEXT;
UPDATE "account" SET "taLinkedAt" = "createdAt";
ALTER TABLE "session" ADD COLUMN "taLastSeenAt" TEXT;
UPDATE "session" SET "taLastSeenAt" = "updatedAt";
ALTER TABLE "verification" ADD COLUMN "taPurpose" TEXT;
ALTER TABLE "verification" ADD COLUMN "taValueHash" TEXT;
ALTER TABLE "verification" ADD COLUMN "taConsumedAt" TEXT;
ALTER TABLE "verification" ADD COLUMN "taData" TEXT;
ALTER TABLE "passkey" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "passkey" SET "taUpdatedAt" = "createdAt";
ALTER TABLE "organization" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "organization" SET "taUpdatedAt" = "createdAt";
ALTER TABLE "member" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "member" SET "taUpdatedAt" = "createdAt";
ALTER TABLE "invitation" ADD COLUMN "taTokenHash" TEXT;
ALTER TABLE "invitation" ADD COLUMN "taAcceptedAt" TEXT;
ALTER TABLE "invitation" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "invitation" SET "taUpdatedAt" = "createdAt";
CREATE INDEX ix_session__active_organization_id ON "session" ("activeOrganizationId");
CREATE UNIQUE INDEX ux_verification__ta_value_hash ON "verification" ("taValueHash");
CREATE INDEX ix_verification__ta_purpose__identifier ON "verification" ("taPurpose", "identifier");
CREATE UNIQUE INDEX ux_passkey__credential_id ON "passkey" ("credentialID");
CREATE UNIQUE INDEX ux_member__organization_id__user_id ON "member" ("organizationId", "userId");
CREATE UNIQUE INDEX ux_invitation__ta_token_hash ON "invitation" ("taTokenHash");
CREATE INDEX ix_invitation__organization_id__email ON "invitation" ("organizationId", "email");
CREATE TABLE ta_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');
