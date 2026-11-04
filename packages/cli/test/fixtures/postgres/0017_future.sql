-- A fixture of a future schema version 17, for the version gate of
-- authtempo migrate (plan 11c; version 17 since plan 12p). On top of 0016: it
-- adds a table, moves the version, and records its name, as a newer
-- adapter-postgres would. It never ships.
CREATE TABLE ta_future (id text PRIMARY KEY);
UPDATE ta_meta SET value = '17' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name) VALUES ('0017_future');
