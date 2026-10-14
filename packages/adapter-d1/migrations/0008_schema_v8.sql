-- tempo-auth schema version 8 for D1 (SQLite): the second factor apart from
-- its methods (plan 12c). Append-only: never edit a shipped migration.
-- ta_second_factor holds one row per user while at least one method is on:
-- the method list as JSON text, and the keyed hashes of the backup codes,
-- never a code. The copy below moves each enabled ta_totp row here with the
-- same id: a backup code hash is HMAC-SHA256 of <row id>:<code>, so the same
-- id keeps every stored code valid. ta_totp keeps its backup_codes column,
-- unread from version 8 on; a later version drops it. Dates are INTEGER
-- epoch milliseconds. The columns keep the field order of the schema.
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
