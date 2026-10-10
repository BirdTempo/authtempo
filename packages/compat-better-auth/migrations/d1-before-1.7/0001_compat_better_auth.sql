-- tempo-auth compat 0001 for D1 (SQLite): tempo-auth on Better Auth tables from
-- before 1.7, with no account.issuer column. Append-only: never edit this file.
-- The text is compatMigrationSql("sqlite", resolveNames(), "before-1.7"), with
-- Better Auth's default names. It adds two tables (ta_limit, ta_meta), the
-- issuer column filled from providerId, nullable ta columns, and unique keys.
-- Tables of Better Auth 1.7: use migrations/d1 instead.
-- It stops with "CHECK constraint failed: tempo_auth_compat_every_better_auth_date_must_be_text"
-- when a Better Auth date is not date text (an integer timestamp), before any other change.
CREATE TABLE IF NOT EXISTS ta_date_check (ok INTEGER CONSTRAINT tempo_auth_compat_every_better_auth_date_must_be_text CHECK (ok = 1));
INSERT INTO ta_date_check (ok) SELECT NOT (EXISTS (SELECT 1 FROM "user" WHERE ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL)) OR ("updatedAt" IS NOT NULL AND (typeof("updatedAt") <> 'text' OR julianday("updatedAt") IS NULL))) OR EXISTS (SELECT 1 FROM "session" WHERE ("expiresAt" IS NOT NULL AND (typeof("expiresAt") <> 'text' OR julianday("expiresAt") IS NULL)) OR ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL)) OR ("updatedAt" IS NOT NULL AND (typeof("updatedAt") <> 'text' OR julianday("updatedAt") IS NULL))) OR EXISTS (SELECT 1 FROM "account" WHERE ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL)) OR ("updatedAt" IS NOT NULL AND (typeof("updatedAt") <> 'text' OR julianday("updatedAt") IS NULL))) OR EXISTS (SELECT 1 FROM "verification" WHERE ("expiresAt" IS NOT NULL AND (typeof("expiresAt") <> 'text' OR julianday("expiresAt") IS NULL)) OR ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL)) OR ("updatedAt" IS NOT NULL AND (typeof("updatedAt") <> 'text' OR julianday("updatedAt") IS NULL))) OR EXISTS (SELECT 1 FROM "organization" WHERE ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL))) OR EXISTS (SELECT 1 FROM "member" WHERE ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL))) OR EXISTS (SELECT 1 FROM "invitation" WHERE ("expiresAt" IS NOT NULL AND (typeof("expiresAt") <> 'text' OR julianday("expiresAt") IS NULL)) OR ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL))) OR EXISTS (SELECT 1 FROM "passkey" WHERE ("createdAt" IS NOT NULL AND (typeof("createdAt") <> 'text' OR julianday("createdAt") IS NULL))));
DROP TABLE ta_date_check;
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;
UPDATE "account" SET "issuer" = CASE "providerId" WHEN 'credential' THEN 'local:credential' WHEN 'email' THEN 'local:email' WHEN 'google' THEN 'https://accounts.google.com' WHEN 'apple' THEN 'https://appleid.apple.com' ELSE 'local:oauth:' || "providerId" END WHERE "issuer" IS NULL;
CREATE UNIQUE INDEX ux_account__issuer__account_id ON "account" ("issuer", "accountId");
UPDATE "passkey" SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "createdAt" IS NULL;
CREATE TABLE ta_limit (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX ix_ta_limit__expires_at ON ta_limit (expires_at);
ALTER TABLE "account" ADD COLUMN "taLinkedAt" TEXT;
UPDATE "account" SET "taLinkedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt");
ALTER TABLE "session" ADD COLUMN "taLastSeenAt" TEXT;
UPDATE "session" SET "taLastSeenAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt");
ALTER TABLE "verification" ADD COLUMN "taPurpose" TEXT;
ALTER TABLE "verification" ADD COLUMN "taValueHash" TEXT;
ALTER TABLE "verification" ADD COLUMN "taConsumedAt" TEXT;
ALTER TABLE "verification" ADD COLUMN "taData" TEXT;
ALTER TABLE "passkey" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "passkey" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt");
ALTER TABLE "organization" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "organization" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt");
ALTER TABLE "member" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "member" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt");
ALTER TABLE "invitation" ADD COLUMN "taTokenHash" TEXT;
ALTER TABLE "invitation" ADD COLUMN "taAcceptedAt" TEXT;
ALTER TABLE "invitation" ADD COLUMN "taUpdatedAt" TEXT;
UPDATE "invitation" SET "taUpdatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt");
CREATE INDEX ix_session__active_organization_id ON "session" ("activeOrganizationId");
CREATE UNIQUE INDEX ux_verification__ta_value_hash ON "verification" ("taValueHash");
CREATE INDEX ix_verification__ta_purpose__identifier ON "verification" ("taPurpose", "identifier");
CREATE UNIQUE INDEX ux_passkey__credential_id ON "passkey" ("credentialID");
CREATE UNIQUE INDEX ux_member__organization_id__user_id ON "member" ("organizationId", "userId");
CREATE UNIQUE INDEX ux_invitation__ta_token_hash ON "invitation" ("taTokenHash");
CREATE INDEX ix_invitation__organization_id__email ON "invitation" ("organizationId", "email");
CREATE TABLE ta_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');
