-- A fixture of a future schema version 12, for the version gate of
-- authtempo migrate (plan 11c; version 12 since plan 12e). On top of 0011: it
-- adds a table, moves the version, and records its name, as a newer
-- adapter-postgres would. It never ships.
CREATE TABLE ta_future (id text PRIMARY KEY);
UPDATE ta_meta SET value = '12' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name) VALUES ('0012_future');
