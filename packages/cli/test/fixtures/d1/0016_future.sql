-- A fixture of a future schema version 16 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 16 since plan 12i). It runs after the
-- fifteen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '16' WHERE key = 'schema_version';
