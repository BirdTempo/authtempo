-- tempo-auth schema version 4 for D1 (SQLite): passwords. Append-only:
-- never edit a shipped migration.
-- One row per user. The hash names its algorithm and its cost, so a later
-- hash seam can rehash on sign-in. Dates are INTEGER epoch milliseconds.
CREATE TABLE ta_password (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_password__user_id ON ta_password (user_id);

UPDATE ta_meta SET value = '4' WHERE key = 'schema_version';
