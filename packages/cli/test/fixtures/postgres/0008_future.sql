-- A fixture of a future schema version 8, for the version gate of
-- authtempo migrate (plan 11c). It is a real migration on top of 0007: it
-- adds a table, moves the version, and records its name, as a newer
-- adapter-postgres would. It never ships.
CREATE TABLE ta_future (id text PRIMARY KEY);
UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name) VALUES ('0008_future');
