-- A fixture of a future schema version 9 on D1, for the version gate of
-- authtempo migrate (plan 11c). It runs after the eight adapter files, as a
-- newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';
