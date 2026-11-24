-- authtempo schema version 18 for D1 (SQLite): the organization audit and the
-- expiry notices (plan 13b). Append-only: never edit a shipped migration.
-- ta_operator_audit gets organization_id. ta_sso_connection gets
-- certificate_ends_at, expiry_stage, expiry_notice_at, last_success_at,
-- last_failure_at, and last_failure_step. ta_scim_token and ta_sso_setup_link
-- get expiry_stage and expiry_notice_at. Each new column is nullable with no
-- default, so a row of version 17 reads null in each. An audit row is
-- append-only: this file adds a column and an index, and changes no row. No
-- backfill: a row from before version 18 keeps a null organization_id. One
-- index on (organization_id, id) serves the filter and the order of the
-- organization audit. The index on expiry_notice_at serves the sweep. Dates
-- are INTEGER epoch milliseconds. The columns keep the field order of the schema.
ALTER TABLE ta_operator_audit ADD COLUMN organization_id TEXT;
ALTER TABLE ta_sso_connection ADD COLUMN certificate_ends_at INTEGER;
ALTER TABLE ta_sso_connection ADD COLUMN expiry_stage INTEGER;
ALTER TABLE ta_sso_connection ADD COLUMN expiry_notice_at INTEGER;
ALTER TABLE ta_sso_connection ADD COLUMN last_success_at INTEGER;
ALTER TABLE ta_sso_connection ADD COLUMN last_failure_at INTEGER;
ALTER TABLE ta_sso_connection ADD COLUMN last_failure_step TEXT;
ALTER TABLE ta_scim_token ADD COLUMN expiry_stage INTEGER;
ALTER TABLE ta_scim_token ADD COLUMN expiry_notice_at INTEGER;
ALTER TABLE ta_sso_setup_link ADD COLUMN expiry_stage INTEGER;
ALTER TABLE ta_sso_setup_link ADD COLUMN expiry_notice_at INTEGER;
CREATE INDEX ix_ta_operator_audit__organization_id__id ON ta_operator_audit (organization_id, id);
CREATE INDEX ix_ta_sso_connection__expiry_notice_at ON ta_sso_connection (expiry_notice_at);
CREATE INDEX ix_ta_scim_token__expiry_notice_at ON ta_scim_token (expiry_notice_at);
CREATE INDEX ix_ta_sso_setup_link__expiry_notice_at ON ta_sso_setup_link (expiry_notice_at);

UPDATE ta_meta SET value = '18' WHERE key = 'schema_version';
