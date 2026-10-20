-- A fixture of a future schema version 13 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 13 since plan 12f). It runs after the
-- twelve adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
