-- authtempo schema version 16 for D1 (SQLite): the session proof (plan
-- 12p). Append-only: never edit a shipped migration. ta_session gets proved,
-- the mark that the sign-in of the session proved the account. Core sets it
-- once, at the creation of each session. A verified-only action reads it.
-- The column is NOT NULL with the default 0, so a row of version 15 reads
-- false. Then the fill sets 1 on each session whose user has a verified
-- address. So a verified user keeps the powers of each live session. A
-- session of a user with no address, or with an unverified address, keeps
-- 0. That user signs in again for verified powers. A session that a Worker
-- of version 15 writes after the fill reads false too. Booleans are INTEGER.
-- The columns keep the field order of the schema.
ALTER TABLE ta_session ADD COLUMN proved INTEGER NOT NULL DEFAULT 0;
UPDATE ta_session SET proved = 1 WHERE user_id IN (SELECT id FROM ta_user WHERE email_verified = 1 AND email IS NOT NULL);

UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
