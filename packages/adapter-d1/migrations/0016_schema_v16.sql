-- authtempo schema version 16 for D1 (SQLite): the session proof (plan
-- 12p). Append-only: never edit a shipped migration. ta_session gets proved.
-- It is true when the session came after the proof of its address. It is
-- also true when the user has no address and is not anonymous. Core sets it
-- once, at the creation of each session. Only the confirm of a change of
-- address changes it later, to true on the session it keeps. A verified-only
-- action reads it.
-- The column is NOT NULL with the default 0, so a row of version 15 reads
-- false. Then the fill sets 1 on each session whose user has a verified
-- address. So a verified user keeps the powers of each live session. A
-- session of a user with no address, or with an unverified address, keeps
-- 0. A user with no address signs in again for verified powers. A user with
-- an unverified address proves it first. A session that a Worker of
-- version 15 writes after the fill reads false too. Booleans are INTEGER.
-- The columns keep the field order of the schema.
--
-- The fill is one statement. It changes one row for each session of a
-- verified user. The Cloudflare D1 limits page, read 2026-11-04, says that a
-- single query that changes hundreds of thousands of rows exceeds the
-- execution limits. It says that a large UPDATE must run in batches. Run the
-- sweep first, so that the expired sessions are gone. An app with more than
-- 100,000 live sessions of verified users applies this migration by hand, in
-- pages, with the commands below. The ceiling keeps the one statement below
-- hundreds of thousands of rows. The first command counts those sessions.
-- The second adds the column. The third fills one page of 10,000 rows: run
-- it again until meta.changes of its answer is 0. The fourth writes the
-- version. The fifth marks this file as applied in d1_migrations, the table
-- of wrangler d1 migrations. That name and its columns come from the code of
-- wrangler 4.148.0, read 2026-11-04. test/schema-v16.test.ts runs these
-- commands, and holds the schema page and the README to them.
--   wrangler d1 execute my-app --remote --command "SELECT COUNT(*) AS sessions FROM ta_session s JOIN ta_user u ON u.id = s.user_id WHERE u.email_verified = 1 AND u.email IS NOT NULL"
--   wrangler d1 execute my-app --remote --command "ALTER TABLE ta_session ADD COLUMN proved INTEGER NOT NULL DEFAULT 0"
--   wrangler d1 execute my-app --remote --json --command "UPDATE ta_session SET proved = 1 WHERE proved = 0 AND id IN (SELECT s.id FROM ta_session s JOIN ta_user u ON u.id = s.user_id WHERE u.email_verified = 1 AND u.email IS NOT NULL AND s.proved = 0 LIMIT 10000)"
--   wrangler d1 execute my-app --remote --command "UPDATE ta_meta SET value = '16' WHERE key = 'schema_version'"
--   wrangler d1 execute my-app --remote --command "INSERT INTO d1_migrations (name) VALUES ('0016_schema_v16.sql')"
ALTER TABLE ta_session ADD COLUMN proved INTEGER NOT NULL DEFAULT 0;
UPDATE ta_session SET proved = 1 WHERE user_id IN (SELECT id FROM ta_user WHERE email_verified = 1 AND email IS NOT NULL);

UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
