/**
 * Schema version 15 (plan 12i): the sign-in additions. A user can have no
 * address, so `ta_user.email` becomes nullable. `ta_user` gets `username`,
 * `display_username`, `phone`, and `is_anonymous` as its last columns, with
 * the unique keys of the username and the phone; a NULL never conflicts.
 * `ta_passkey` gets the three extension flags of plan 12i Task 21.
 * `ta_oauth_session_client` and `ta_oauth_logout` get the nullable `issuer`
 * of plan 12i Task 18: the logout token names the issuer that the client
 * saw. The column texts are those of schemaDdl(MYSQL) of core on the day of
 * this file (2026-10-24; the issuer 2026-10-25). `is_anonymous`, `prf`,
 * and `large_blob` default to 0, so a row of version 14 reads as false.
 * MySQL 8.0 runs each ALTER as one atomic statement. The last statement
 * writes the version, so a migration that stops early never reports its
 * version. Append-only: never edit a shipped migration.
 */
export const name = "0003_schema_v15";

export const statements: readonly string[] = [
  "ALTER TABLE `ta_user` MODIFY `email` VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
  "ALTER TABLE `ta_user` ADD COLUMN `username` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin, ADD COLUMN `display_username` TEXT, ADD COLUMN `phone` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin, ADD COLUMN `is_anonymous` TINYINT(1) NOT NULL DEFAULT 0, ADD UNIQUE KEY `ux_ta_user__username` (`username`), ADD UNIQUE KEY `ux_ta_user__phone` (`phone`)",
  "ALTER TABLE `ta_passkey` ADD COLUMN `discoverable` TINYINT(1), ADD COLUMN `prf` TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN `large_blob` TINYINT(1) NOT NULL DEFAULT 0",
  "ALTER TABLE `ta_oauth_session_client` ADD COLUMN `issuer` TEXT",
  "ALTER TABLE `ta_oauth_logout` ADD COLUMN `issuer` TEXT",
  "UPDATE `ta_meta` SET `value` = '15' WHERE `key` = 'schema_version'",
];
