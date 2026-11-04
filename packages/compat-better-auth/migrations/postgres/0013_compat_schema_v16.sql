ALTER TABLE "session" ADD COLUMN "taProved" boolean NOT NULL DEFAULT false;
UPDATE "session" SET "taProved" = true WHERE "userId" IN (SELECT "id" FROM "user" WHERE "emailVerified" IS TRUE AND "email" IS NOT NULL AND NOT (lower("email") LIKE '%@placeholder.invalid' OR lower("email") LIKE '%.placeholder.invalid'));
UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '13' WHERE key = 'compat_better_auth';
