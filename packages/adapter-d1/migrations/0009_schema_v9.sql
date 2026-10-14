-- authtempo schema version 9 for D1 (SQLite): the secret version of each
-- sealed value and keyed hash (plan 12b, spec 22). Append-only: never edit a
-- shipped migration. The default 1 is the version of every value of today:
-- before plan 12b one app secret sealed and keyed them all. A read opens a
-- value only under the version its row names. The table names keep the
-- prefix ta_ of the old product name.
ALTER TABLE ta_totp ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_second_factor ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_verification ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ta_jwk ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;

UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';
