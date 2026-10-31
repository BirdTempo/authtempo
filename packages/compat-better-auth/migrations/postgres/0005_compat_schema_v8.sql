CREATE TABLE ta_second_factor (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  enabled_at timestamptz NOT NULL,
  methods jsonb NOT NULL,
  backup_codes jsonb NOT NULL,
  backup_codes_version integer NOT NULL
);
CREATE UNIQUE INDEX ux_ta_second_factor__user_id ON ta_second_factor (user_id);
INSERT INTO ta_second_factor (id, created_at, updated_at, user_id, enabled_at, methods, backup_codes, backup_codes_version)
SELECT id, created_at, updated_at, user_id, enabled_at, '["totp"]'::jsonb, backup_codes, 1
FROM ta_totp
WHERE enabled_at IS NOT NULL;
-- A plan 9f setup holds codes of 8 to 12 characters. The person runs the setup again.
DELETE FROM ta_totp WHERE enabled_at IS NULL;
UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '5' WHERE key = 'compat_better_auth';
