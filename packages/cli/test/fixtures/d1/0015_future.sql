-- A fixture of a future schema version 15 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 15 since plan 12d). It runs after the
-- fourteen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '15' WHERE key = 'schema_version';
