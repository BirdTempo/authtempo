/**
 * Schema version 16 (plan 12p): the session proof. `ta_session` gets
 * `proved`, the mark that the sign-in of the session proved the account.
 * Core sets it once, at the creation of each session. Only the confirm of
 * a change of address changes it later, to true on the session it keeps.
 * A verified-only action reads it. The column text is that of
 * schemaDdl(MYSQL) of core on the day of this file (2026-11-04). It is NOT
 * NULL with the default 0, so a row of version 15 reads false. Then the
 * fill sets 1 on each session whose user has a verified address. So a
 * verified user keeps the powers of each live session. A session of a user
 * with no address, or with an unverified address, keeps 0. That user signs
 * in again for verified powers. MySQL 8.0 runs each statement as one
 * atomic statement. The fill sets the same value when it runs again, so
 * the runner can resume after it. The last statement writes the version,
 * so a migration that stops early never reports its version. Append-only:
 * never edit a shipped migration.
 */
export const name = "0004_schema_v16";

export const statements: readonly string[] = [
  "ALTER TABLE `ta_session` ADD COLUMN `proved` TINYINT(1) NOT NULL DEFAULT 0",
  "UPDATE `ta_session` SET `proved` = 1 WHERE `user_id` IN (SELECT `id` FROM `ta_user` WHERE `email_verified` = 1 AND `email` IS NOT NULL)",
  "UPDATE `ta_meta` SET `value` = '16' WHERE `key` = 'schema_version'",
];
