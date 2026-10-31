DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('user', 'session', 'account', 'verification', 'organization', 'member', 'invitation', 'passkey') AND data_type = 'timestamp without time zone') THEN
    RAISE EXCEPTION 'authtempo compat: every Better Auth date column must be timestamptz';
  END IF;
END $$;
CREATE TABLE ta_limit (key text PRIMARY KEY, window_start bigint NOT NULL, count bigint NOT NULL, expires_at bigint NOT NULL);
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;
UPDATE "account" SET "issuer" = CASE "providerId" WHEN 'credential' THEN 'local:credential' WHEN 'email' THEN 'local:email' WHEN 'google' THEN 'https://accounts.google.com' WHEN 'apple' THEN 'https://appleid.apple.com' ELSE 'local:oauth:' || "providerId" END WHERE "issuer" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace s ON s.oid = t.relnamespace WHERE s.nspname = current_schema() AND t.relname = 'account' AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 2 AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey)) = ARRAY['accountId', 'issuer']) THEN
    CREATE UNIQUE INDEX ux_account__issuer__account_id ON "account" ("issuer", "accountId");
  END IF;
END $$;
UPDATE "passkey" SET "createdAt" = date_trunc('milliseconds', now()) WHERE "createdAt" IS NULL;
CREATE INDEX ix_ta_limit__expires_at ON ta_limit (expires_at);
ALTER TABLE "account" ADD COLUMN "taLinkedAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "account" SET "taLinkedAt" = date_trunc('milliseconds', "createdAt");
ALTER TABLE "session" ADD COLUMN "taLastSeenAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "session" SET "taLastSeenAt" = date_trunc('milliseconds', "updatedAt");
ALTER TABLE "verification" ADD COLUMN "taPurpose" text;
ALTER TABLE "verification" ADD COLUMN "taValueHash" text;
ALTER TABLE "verification" ADD COLUMN "taConsumedAt" timestamptz;
ALTER TABLE "verification" ADD COLUMN "taData" text;
ALTER TABLE "passkey" ADD COLUMN "taUpdatedAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "passkey" SET "taUpdatedAt" = date_trunc('milliseconds', "createdAt");
ALTER TABLE "organization" ADD COLUMN "taUpdatedAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "organization" SET "taUpdatedAt" = date_trunc('milliseconds', "createdAt");
ALTER TABLE "member" ADD COLUMN "taUpdatedAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "member" SET "taUpdatedAt" = date_trunc('milliseconds', "createdAt");
ALTER TABLE "invitation" ADD COLUMN "taTokenHash" text;
ALTER TABLE "invitation" ADD COLUMN "taAcceptedAt" timestamptz;
ALTER TABLE "invitation" ADD COLUMN "taUpdatedAt" timestamptz DEFAULT date_trunc('milliseconds', now());
UPDATE "invitation" SET "taUpdatedAt" = date_trunc('milliseconds', "createdAt");
CREATE INDEX ix_session__active_organization_id ON "session" ("activeOrganizationId");
CREATE UNIQUE INDEX ux_verification__ta_value_hash ON "verification" ("taValueHash");
CREATE INDEX ix_verification__ta_purpose__identifier ON "verification" ("taPurpose", "identifier");
CREATE UNIQUE INDEX ux_passkey__credential_id ON "passkey" ("credentialID");
CREATE UNIQUE INDEX ux_member__organization_id__user_id ON "member" ("organizationId", "userId");
CREATE UNIQUE INDEX ux_invitation__ta_token_hash ON "invitation" ("taTokenHash");
CREATE INDEX ix_invitation__organization_id__email ON "invitation" ("organizationId", "email");
CREATE TABLE ta_meta (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');
