-- authtempo compat migration 0015 (plan 13b): core schema version 18.
-- Append-only. Core 18 adds the organization audit and the expiry notices.
-- The audit, SSO, and SCIM tables are core's own tables in this database, so
-- the text is the statements of core 0018. ta_operator_audit gets
-- organization_id. ta_sso_connection gets the expiry and health columns.
-- ta_scim_token and ta_sso_setup_link get expiry_stage and expiry_notice_at.
-- Each new column is nullable with no default, and the text changes no row.
-- The text names ta_ tables only, so it is the same for every naming and for
-- both variants.
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
UPDATE ta_meta SET value = '15' WHERE key = 'compat_better_auth';
