-- authtempo compat migration 0012 (plan 12i): core schema version 15.
-- Append-only. Core 15 lets a user have no address and adds the username,
-- the phone, and the anonymous flag. Better Auth's user table gets the
-- columns of its username, phone number, and anonymous plugins, with a
-- unique key on username and on phoneNumber. An app whose user table holds
-- those columns already runs this file without its first five lines and
-- without the unique key that it holds. Better Auth's user.email stays NOT
-- NULL. The index on isAnonymous and createdAt serves the anonymous step
-- of core's sweep (ruling 25 H1 of plan 12i, 2026-10-24). It was added
-- before this file left the lane: no database outside the tests ran it.
-- Better Auth's passkey table gets the three extension flags of core.
-- Core's ta_oauth_session_client and ta_oauth_logout get the nullable issuer
-- of plan 12i Task 18.
-- This is the text of the default naming, the same for both variants.
ALTER TABLE "user" ADD COLUMN "username" TEXT;
ALTER TABLE "user" ADD COLUMN "displayUsername" TEXT;
ALTER TABLE "user" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "user" ADD COLUMN "phoneNumberVerified" INTEGER;
ALTER TABLE "user" ADD COLUMN "isAnonymous" INTEGER DEFAULT 0;
UPDATE "user" SET "isAnonymous" = 0 WHERE "isAnonymous" IS NULL;
CREATE UNIQUE INDEX ux_user__username ON "user" ("username");
CREATE UNIQUE INDEX ux_user__phone_number ON "user" ("phoneNumber");
CREATE INDEX ix_user__is_anonymous__created_at ON "user" ("isAnonymous", "createdAt");
ALTER TABLE "passkey" ADD COLUMN "taDiscoverable" INTEGER;
ALTER TABLE "passkey" ADD COLUMN "taPrf" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "passkey" ADD COLUMN "taLargeBlob" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_session_client ADD COLUMN issuer TEXT;
ALTER TABLE ta_oauth_logout ADD COLUMN issuer TEXT;
UPDATE ta_meta SET value = '15' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '12' WHERE key = 'compat_better_auth';
