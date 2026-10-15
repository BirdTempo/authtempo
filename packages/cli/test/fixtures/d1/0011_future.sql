-- A fixture of a future schema version 11 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 11 since plan 12a). It runs after the
-- ten adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '11' WHERE key = 'schema_version';
