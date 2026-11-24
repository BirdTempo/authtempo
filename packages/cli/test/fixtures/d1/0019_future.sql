-- A fixture of a future schema version 19 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 19 since plan 13b). It runs after the
-- eighteen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '19' WHERE key = 'schema_version';
