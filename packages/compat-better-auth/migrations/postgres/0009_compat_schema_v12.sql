ALTER TABLE "user" ADD COLUMN "taBannedAt" timestamptz;
ALTER TABLE "user" ADD COLUMN "taBanReason" text;
ALTER TABLE "user" ADD COLUMN "taBanUntil" timestamptz;
ALTER TABLE "session" ADD COLUMN "taActorId" text;
UPDATE "user" AS u SET "taBannedAt" = date_trunc('milliseconds', u."updatedAt"), "taBanReason" = (SELECT (SELECT "banReason" FROM "user" AS b WHERE b."id" = u."id") FROM (SELECT NULL::text AS "banReason") AS fallback), "taBanUntil" = (SELECT (SELECT date_trunc('milliseconds', "banExpires") FROM "user" AS b WHERE b."id" = u."id") FROM (SELECT NULL::timestamptz AS "banExpires") AS fallback) WHERE u."taBannedAt" IS NULL AND (SELECT (SELECT "banned" FROM "user" AS b WHERE b."id" = u."id") FROM (SELECT false AS "banned") AS fallback) IS TRUE;
CREATE TABLE ta_operator_audit (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_user_id text,
  reason text NOT NULL,
  data jsonb,
  ip text,
  user_agent text
);
CREATE INDEX ix_ta_operator_audit__target_user_id ON ta_operator_audit (target_user_id);
CREATE INDEX ix_ta_operator_audit__actor_id ON ta_operator_audit (actor_id);
UPDATE ta_meta SET value = '12' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '9' WHERE key = 'compat_better_auth';
