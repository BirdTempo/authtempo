/**
 * authtempo schema version 10 for Postgres: account self-service (plan
 * 12a). Append-only: never edit a shipped migration. ta_session gets
 * fresh_at, the time a sign-in or a re-authentication last proved the
 * person. There is no default and no fill: a row of version 9 holds NULL,
 * and NULL is never fresh. The three new verification purposes need no DDL.
 */
export const name = "0010_schema_v10";
export const sql = `
ALTER TABLE ta_session ADD COLUMN fresh_at timestamptz;

UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';
`;
