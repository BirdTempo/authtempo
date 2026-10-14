-- tempo-auth compat migration 0005 (plan 12c): core schema version 8.
-- Append-only. Core 8 adds the second factor apart from its methods. This
-- file creates core's own ta_second_factor beside the Better Auth tables and
-- copies each enabled ta_totp row into it with the same id, so every stored
-- backup code stays valid. Apply it after 0004 for every naming and both
-- variants: it names ta_ tables only.
CREATE TABLE ta_second_factor (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  methods TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  backup_codes_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_second_factor__user_id ON ta_second_factor (user_id);
INSERT INTO ta_second_factor (id, created_at, updated_at, user_id, enabled_at, methods, backup_codes, backup_codes_version)
SELECT id, created_at, updated_at, user_id, enabled_at, '["totp"]', backup_codes, 1
FROM ta_totp
WHERE enabled_at IS NOT NULL;
-- A plan 9f setup holds codes of 8 to 12 characters. The person runs the setup again.
DELETE FROM ta_totp WHERE enabled_at IS NULL;
UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '5' WHERE key = 'compat_better_auth';
