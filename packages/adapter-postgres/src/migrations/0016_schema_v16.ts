/**
 * authtempo schema version 16 for Postgres: the session proof (plan 12p).
 * Append-only: never edit a shipped migration. ta_session gets proved, the
 * mark that the sign-in of the session proved the account. Core sets it
 * once, at the creation of each session. A verified-only action reads it.
 * The column is NOT NULL with the default false, so a row of version 15
 * reads false. Then the fill sets true on each session whose user has a
 * verified address. So a verified user keeps the powers of each live
 * session. A session of a user with no address, or with an unverified
 * address, keeps false. That user signs in again for verified powers. The
 * runner applies the text in one transaction, so no session of version 15
 * goes in between the column and the fill. The columns keep the field
 * order of the schema.
 */
export const name = "0016_schema_v16";
export const sql = `
ALTER TABLE ta_session ADD COLUMN proved boolean NOT NULL DEFAULT false;
UPDATE ta_session SET proved = true WHERE user_id IN (SELECT id FROM ta_user WHERE email_verified = true AND email IS NOT NULL);

UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
`;
