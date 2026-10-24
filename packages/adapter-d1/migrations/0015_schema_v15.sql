-- authtempo schema version 15 for D1 (SQLite): the sign-in additions (plan
-- 12i). Append-only: never edit a shipped migration. A user can have no
-- address, so ta_user.email loses NOT NULL. SQLite cannot drop NOT NULL.
-- Rebuild ta_user; no table refers to it (no REFERENCES in 0001 to 0014,
-- read at plan 12i Task 1). The new table has every column of version 14 in
-- its order, then username, display_username, phone, and is_anonymous. The
-- copy names the columns of version 14, so the new columns take NULL and the
-- default 0. Each of email, username, and phone has a unique index; a NULL
-- never conflicts. The index on (is_anonymous, created_at) serves the
-- anonymous step of the sweep (ruling 25 H1 of plan 12i, 2026-10-24). It was
-- added before schema 15 left the lane: no database outside the tests ran
-- this file. ta_passkey gets the three extension flags of plan 12i
-- Task 21. ta_oauth_session_client and ta_oauth_logout get the nullable
-- issuer of plan 12i Task 18: the logout token names the issuer that the
-- client saw. Booleans are INTEGER, and dates are INTEGER epoch
-- milliseconds. The columns keep the field order of the schema.
CREATE TABLE ta_user_v15 (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL,
  name TEXT,
  image TEXT,
  banned_at INTEGER,
  ban_reason TEXT,
  ban_until INTEGER,
  username TEXT,
  display_username TEXT,
  phone TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ta_user_v15 (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until)
SELECT id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until FROM ta_user;
DROP TABLE ta_user;
ALTER TABLE ta_user_v15 RENAME TO ta_user;
CREATE UNIQUE INDEX ux_ta_user__email ON ta_user (email);
CREATE UNIQUE INDEX ux_ta_user__username ON ta_user (username);
CREATE UNIQUE INDEX ux_ta_user__phone ON ta_user (phone);
CREATE INDEX ix_ta_user__is_anonymous__created_at ON ta_user (is_anonymous, created_at);

ALTER TABLE ta_passkey ADD COLUMN discoverable INTEGER;
ALTER TABLE ta_passkey ADD COLUMN prf INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_passkey ADD COLUMN large_blob INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ta_oauth_session_client ADD COLUMN issuer TEXT;
ALTER TABLE ta_oauth_logout ADD COLUMN issuer TEXT;

UPDATE ta_meta SET value = '15' WHERE key = 'schema_version';
