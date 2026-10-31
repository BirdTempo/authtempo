ALTER TABLE "session" ADD COLUMN "taFreshAt" timestamptz;
UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '7' WHERE key = 'compat_better_auth';
