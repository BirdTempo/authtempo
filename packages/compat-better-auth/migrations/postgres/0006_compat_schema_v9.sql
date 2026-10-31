ALTER TABLE ta_totp ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_second_factor ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_jwk ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE "verification" ADD COLUMN "taSecretVersion" integer NOT NULL DEFAULT 1;
UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '6' WHERE key = 'compat_better_auth';
