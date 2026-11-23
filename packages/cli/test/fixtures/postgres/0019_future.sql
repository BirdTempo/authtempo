-- A fixture of a future schema version 19, for the version gate of
-- authtempo migrate (plan 11c; version 19 since plan 13b). On top of 0018: it
-- adds a table, moves the version, and records its name, as a newer
-- adapter-postgres would. It never ships.
CREATE TABLE ta_future (id text PRIMARY KEY);
UPDATE ta_meta SET value = '19' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name) VALUES ('0019_future');
