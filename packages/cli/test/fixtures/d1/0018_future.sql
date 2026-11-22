-- A fixture of a future schema version 18 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 18 since plan 13a). It runs after the
-- seventeen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '18' WHERE key = 'schema_version';
