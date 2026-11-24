-- A fixture of a future schema version 19 on SQLite, for the version gate of
-- authtempo migrate (plan 12g Task 6). Plan 13b moved it from version 18 to 19.
-- On top of 0018: it adds a table, moves the version, and records its name in
-- the runner's table, as a newer adapter-sqlite would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '19' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name, applied_at) VALUES ('0019_future', 0);
