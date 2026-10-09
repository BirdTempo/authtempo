-- tempo-auth schema version 2 for D1 (SQLite): organizations. Append-only.
-- Names come from @tempo-auth/core/sql: tables ta_<model>, columns snake_case,
-- unique indexes ux_<table>__<col>__<col>, indexes ix_<table>__<col>.

CREATE TABLE ta_organization (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata TEXT
);
CREATE UNIQUE INDEX ux_ta_organization__slug ON ta_organization (slug);

CREATE TABLE ta_member (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_member__organization_id__user_id ON ta_member (organization_id, user_id);
CREATE INDEX ix_ta_member__user_id ON ta_member (user_id);

CREATE TABLE ta_invitation (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_invitation__token_hash ON ta_invitation (token_hash);
CREATE INDEX ix_ta_invitation__organization_id__email ON ta_invitation (organization_id, email);

UPDATE ta_meta SET value = '2' WHERE key = 'schema_version';
