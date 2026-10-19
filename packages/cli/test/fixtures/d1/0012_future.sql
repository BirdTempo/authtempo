-- A fixture of a future schema version 12 on D1, for the version gate of
-- authtempo migrate (plan 11c; version 12 since plan 12e). It runs after the
-- eleven adapter files, as a newer adapter-d1 would. It never ships.
CREATE TABLE ta_future (id TEXT PRIMARY KEY);
UPDATE ta_meta SET value = '12' WHERE key = 'schema_version';
