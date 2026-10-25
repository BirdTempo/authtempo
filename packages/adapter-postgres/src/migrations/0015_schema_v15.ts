/**
 * authtempo schema version 15 for Postgres: the sign-in additions (plan
 * 12i). Append-only: never edit a shipped migration. A user can have no
 * address, so ta_user.email drops NOT NULL. ta_user gets username,
 * display_username, phone, and is_anonymous as its last columns. Each of
 * email, username, and phone has a unique index; a NULL never conflicts.
 * is_anonymous is NOT NULL with the default false, so a row of version 14
 * reads as a user that is not anonymous. The index on (is_anonymous,
 * created_at) serves the anonymous step of the sweep (ruling 25 H1 of plan
 * 12i, 2026-10-24). It was added before schema 15 left the lane: no
 * database outside the tests ran this file. ta_passkey gets the three extension
 * flags of plan 12i Task 21: discoverable is nullable, and prf and
 * large_blob default to false. ta_oauth_session_client and ta_oauth_logout
 * get the nullable issuer of plan 12i Task 18: the logout token names the
 * issuer that the client saw. The runner applies the text in one
 * transaction. The columns keep the field order of the schema.
 */
export const name = "0015_schema_v15";
export const sql = `
ALTER TABLE ta_user ALTER COLUMN email DROP NOT NULL;
ALTER TABLE ta_user ADD COLUMN username text;
ALTER TABLE ta_user ADD COLUMN display_username text;
ALTER TABLE ta_user ADD COLUMN phone text;
ALTER TABLE ta_user ADD COLUMN is_anonymous boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX ux_ta_user__username ON ta_user (username);
CREATE UNIQUE INDEX ux_ta_user__phone ON ta_user (phone);
CREATE INDEX ix_ta_user__is_anonymous__created_at ON ta_user (is_anonymous, created_at);

ALTER TABLE ta_passkey ADD COLUMN discoverable boolean;
ALTER TABLE ta_passkey ADD COLUMN prf boolean NOT NULL DEFAULT false;
ALTER TABLE ta_passkey ADD COLUMN large_blob boolean NOT NULL DEFAULT false;

ALTER TABLE ta_oauth_session_client ADD COLUMN issuer text;
ALTER TABLE ta_oauth_logout ADD COLUMN issuer text;

UPDATE ta_meta SET value = '15' WHERE key = 'schema_version';
`;
