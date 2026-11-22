-- A fixture of a future schema version 18 on SQLite, for the version gate of
-- authtempo migrate (plan 12g Task 6). Plan 13a moved it from version 17 to 18.
-- On top of 0017: it adds a table, moves the version, and records its name in
-- the runner's table, as a newer adapter-sqlite would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '18' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name, applied_at) VALUES ('0018_future', 0);
