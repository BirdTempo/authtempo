/**
 * Schema version 17 (plan 13a): the enterprise setup. `ta_sso_connection`
 * gets `draft`, `version`, and `setup_link_id`. `ta_sso_domain` gets
 * `setup_link_id`. `ta_scim_token` gets `pending` and `setup_link_id`.
 * `draft` and `pending` are NOT NULL with the default 0, and `version` is NOT
 * NULL with the default 1. So a row of version 16 reads as no draft, at
 * version 1, with no setup link, and not pending. Core writes every field,
 * so these defaults live in this file only. Three new tables hold the setup
 * links, the test runs, and the setup sessions. The column types and the
 * table text are those of schemaDdl(MYSQL) of core on the day of this file
 * (2026-11-23). MySQL 8.0 runs each statement as one atomic statement, so
 * each ALTER adds all its columns or none. The last statement writes the
 * version, so a migration that stops early never reports its version.
 * Append-only: never edit a shipped migration.
 */
export const name = "0005_schema_v17";

export const statements: readonly string[] = [
  "ALTER TABLE `ta_sso_connection` ADD COLUMN `draft` TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN `version` INT NOT NULL DEFAULT 1, ADD COLUMN `setup_link_id` TEXT",
  "ALTER TABLE `ta_sso_domain` ADD COLUMN `setup_link_id` TEXT",
  "ALTER TABLE `ta_scim_token` ADD COLUMN `pending` TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN `setup_link_id` TEXT",
  "CREATE TABLE `ta_sso_setup_link` (\n  `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `created_at` BIGINT NOT NULL,\n  `updated_at` BIGINT NOT NULL,\n  `organization_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `token_hash` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `hint` TEXT NOT NULL,\n  `steps` JSON NOT NULL,\n  `kinds` JSON NOT NULL,\n  `note` TEXT NOT NULL,\n  `created_by` TEXT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `revoked_at` BIGINT,\n  `ended_at` BIGINT,\n  `opened_at` BIGINT,\n  `ready_at` BIGINT,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `ux_ta_sso_setup_link__token_hash` (`token_hash`),\n  KEY `ix_ta_sso_setup_link__organization_id` (`organization_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE `ta_sso_test_run` (\n  `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `created_at` BIGINT NOT NULL,\n  `updated_at` BIGINT NOT NULL,\n  `organization_id` TEXT NOT NULL,\n  `connection_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `link_id` TEXT,\n  `outcome` TEXT NOT NULL,\n  `step` TEXT,\n  `attribute_names` JSON NOT NULL,\n  `domain_claimed` TINYINT(1) NOT NULL,\n  `draft_version` INT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_ta_sso_test_run__connection_id` (`connection_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE `ta_sso_setup_session` (\n  `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `created_at` BIGINT NOT NULL,\n  `updated_at` BIGINT NOT NULL,\n  `link_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `organization_id` TEXT NOT NULL,\n  `token_hash` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n  `last_seen_at` BIGINT NOT NULL,\n  `expires_at` BIGINT NOT NULL,\n  `ended_at` BIGINT,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `ux_ta_sso_setup_session__token_hash` (`token_hash`),\n  KEY `ix_ta_sso_setup_session__link_id` (`link_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "UPDATE `ta_meta` SET `value` = '17' WHERE `key` = 'schema_version'",
];
