-- A fixture of a future schema version 17 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 17 since plan 12p). It runs after the
-- sixteen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '17' WHERE key = 'schema_version';
