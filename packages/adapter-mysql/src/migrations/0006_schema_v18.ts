/**
 * Schema version 18 (plan 13b): the organization audit and the expiry
 * notices. `ta_operator_audit` gets `organization_id` and the key on
 * (`organization_id`, `id`), which serves the filter and the order of the
 * organization audit. `ta_sso_connection` gets `certificate_ends_at`,
 * `expiry_stage`, `expiry_notice_at`, `last_success_at`, `last_failure_at`,
 * and `last_failure_step`. `ta_scim_token` and `ta_sso_setup_link` get
 * `expiry_stage` and `expiry_notice_at`. Each of the three gets a key on
 * `expiry_notice_at` for the sweep. Each new column is nullable with no
 * default, so a row of version 17 reads null in each. An audit row is
 * append-only: no step changes a row of it. No backfill: a row from before
 * version 18 keeps a null `organization_id`. The column types and the key
 * text are those of schemaDdl(MYSQL) of core on the day of this file
 * (2026-11-23). MySQL 8.0 runs each statement as one atomic statement, so
 * each ALTER adds all its columns or none. The last statement writes the
 * version, so a migration that stops early never reports its version.
 * Append-only: never edit a shipped migration.
 *
 * Each table gets two statements: first the columns, then the key (final
 * review M3, 2026-11-24). A key has no INSTANT algorithm, so an ALTER with a
 * column and a key runs INPLACE, and InnoDB rebuilds the table for the
 * column. `ta_operator_audit` only grows, so that rebuild grows with it.
 * Alone, the column add is INSTANT: a change of metadata, with no copy of a
 * row. The key is then built INPLACE with no rebuild, and writes go on
 * during the build. test/schema-v18.test.ts reads the row versions of
 * InnoDB on MySQL 8.4 and 9.7 to prove that no table was rebuilt.
 */
export const name = "0006_schema_v18";

export const statements: readonly string[] = [
  "ALTER TABLE `ta_operator_audit` ADD COLUMN `organization_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin",
  "ALTER TABLE `ta_operator_audit` ADD KEY `ix_ta_operator_audit__organization_id__id` (`organization_id`, `id`)",
  "ALTER TABLE `ta_sso_connection` ADD COLUMN `certificate_ends_at` BIGINT, ADD COLUMN `expiry_stage` INT, ADD COLUMN `expiry_notice_at` BIGINT, ADD COLUMN `last_success_at` BIGINT, ADD COLUMN `last_failure_at` BIGINT, ADD COLUMN `last_failure_step` TEXT",
  "ALTER TABLE `ta_sso_connection` ADD KEY `ix_ta_sso_connection__expiry_notice_at` (`expiry_notice_at`)",
  "ALTER TABLE `ta_scim_token` ADD COLUMN `expiry_stage` INT, ADD COLUMN `expiry_notice_at` BIGINT",
  "ALTER TABLE `ta_scim_token` ADD KEY `ix_ta_scim_token__expiry_notice_at` (`expiry_notice_at`)",
  "ALTER TABLE `ta_sso_setup_link` ADD COLUMN `expiry_stage` INT, ADD COLUMN `expiry_notice_at` BIGINT",
  "ALTER TABLE `ta_sso_setup_link` ADD KEY `ix_ta_sso_setup_link__expiry_notice_at` (`expiry_notice_at`)",
  "UPDATE `ta_meta` SET `value` = '18' WHERE `key` = 'schema_version'",
];
