/**
 * authtempo schema version 8 for Postgres: the second factor apart from its
 * methods (plan 12c). Append-only: never edit a shipped migration.
 * ta_second_factor holds one row per user while at least one method is on.
 * The copy moves each enabled ta_totp row here with the same id, so every
 * stored backup code hash (keyed by the row id) stays valid. ta_totp keeps
 * its backup_codes column, unread from version 8 on. One transaction holds
 * the create and the copy (the runner's `sql.begin`), so a failed copy
 * leaves version 7. The columns keep the field order of the schema.
 */
export const name = "0008_schema_v8";
export const sql = `
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

UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
`;
