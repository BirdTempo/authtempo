-- A fixture of a future schema version 14 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 14 since plan 12k). It runs after the
-- thirteen adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '14' WHERE key = 'schema_version';
