-- authtempo schema version 13 for D1 (SQLite): organizations and tokens,
-- second version (plan 12k). Append-only: never edit a shipped migration.
-- ta_session gets active_team_id, ta_invitation gets team_ids, and
-- ta_api_token gets the scope, the window, the quota, and the retired mark.
-- Each new column is nullable with no default and no fill. A row of version
-- 12 holds NULL: no team, no scope, no window, no quota, and a live token.
-- The four new tables hold the stored roles, the teams, the team members,
-- and the organization tokens. The table ta_organization_token has no
-- user_id column, so the account delete keeps its rows. JSON is TEXT, and
-- dates are INTEGER epoch milliseconds. The columns keep the field order of
-- the schema.
ALTER TABLE ta_session ADD COLUMN active_team_id TEXT;
ALTER TABLE ta_invitation ADD COLUMN team_ids TEXT;
ALTER TABLE ta_api_token ADD COLUMN permissions TEXT;
ALTER TABLE ta_api_token ADD COLUMN metadata TEXT;
ALTER TABLE ta_api_token ADD COLUMN rate_limit_seconds INTEGER;
ALTER TABLE ta_api_token ADD COLUMN rate_limit_max INTEGER;
ALTER TABLE ta_api_token ADD COLUMN remaining INTEGER;
ALTER TABLE ta_api_token ADD COLUMN refill_amount INTEGER;
ALTER TABLE ta_api_token ADD COLUMN refill_seconds INTEGER;
ALTER TABLE ta_api_token ADD COLUMN last_refill_at INTEGER;
ALTER TABLE ta_api_token ADD COLUMN retired_at INTEGER;
CREATE TABLE ta_organization_role (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  permissions TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_organization_role__organization_id__name ON ta_organization_role (organization_id, name);
CREATE TABLE ta_team (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE INDEX ix_ta_team__organization_id ON ta_team (organization_id);
CREATE TABLE ta_team_member (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_team_member__team_id__user_id ON ta_team_member (team_id, user_id);
CREATE INDEX ix_ta_team_member__user_id ON ta_team_member (user_id);
CREATE INDEX ix_ta_team_member__organization_id__user_id ON ta_team_member (organization_id, user_id);
CREATE TABLE ta_organization_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  permissions TEXT NOT NULL,
  metadata TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  rate_limit_seconds INTEGER,
  rate_limit_max INTEGER,
  remaining INTEGER,
  refill_amount INTEGER,
  refill_seconds INTEGER,
  last_refill_at INTEGER,
  retired_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_organization_token__token_hash ON ta_organization_token (token_hash);
CREATE INDEX ix_ta_organization_token__organization_id ON ta_organization_token (organization_id);

UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
