-- A fixture of a future schema version 17 on SQLite, for the version gate of
-- authtempo migrate (plan 12g Task 6). Plan 12p moved it from version 16 to 17.
-- On top of 0016: it adds a table, moves the version, and records its name in
-- the runner's table, as a newer adapter-sqlite would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '17' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name, applied_at) VALUES ('0017_future', 0);
