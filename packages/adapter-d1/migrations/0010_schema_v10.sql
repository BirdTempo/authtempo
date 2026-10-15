-- authtempo schema version 10 for D1 (SQLite): account self-service
-- (plan 12a). Append-only: never edit a shipped migration. ta_session gets
-- fresh_at, the time a sign-in or a re-authentication last proved the
-- person, as INTEGER epoch milliseconds. There is no default and no fill:
-- a row of version 9 holds NULL, and NULL is never fresh, so that session
-- re-authenticates once before its first sensitive change. The three new
-- verification purposes need no DDL: purpose is a text column.
ALTER TABLE ta_session ADD COLUMN fresh_at INTEGER;

UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';
