-- A fixture of a future schema version 10 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 10 since plan 12b). It runs after the
-- nine adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';
