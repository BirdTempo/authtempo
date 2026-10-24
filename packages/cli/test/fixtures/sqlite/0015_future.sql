-- A fixture of a future schema version 15 on SQLite, for the version gate of
-- authtempo migrate (plan 12g Task 6; version 15 since plan 12d). On top of
-- 0014: it adds a table, moves the version, and records its name in the
-- runner's table, as a newer adapter-sqlite would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '15' WHERE key = 'schema_version';
INSERT INTO ta_migrations (name, applied_at) VALUES ('0015_future', 0);
