/**
 * authtempo schema version 9 for Postgres: the secret version of each
 * sealed value and keyed hash (plan 12b, spec 22). Append-only: never edit a
 * shipped migration. The default 1 is the version of every value of today.
 * Postgres 11 and later add a column with a constant default without a
 * rewrite of the table, so the migration holds no long lock on a large
 * `ta_verification`.
 */
export const name = "0009_schema_v9";
export const sql = `
ALTER TABLE ta_totp ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_second_factor ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_verification ADD COLUMN secret_version integer NOT NULL DEFAULT 1;
ALTER TABLE ta_jwk ADD COLUMN secret_version integer NOT NULL DEFAULT 1;

UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';
`;
