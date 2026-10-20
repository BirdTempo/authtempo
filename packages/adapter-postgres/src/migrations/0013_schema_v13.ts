/**
 * authtempo schema version 13 for Postgres: organizations and tokens, second
 * version (plan 12k). Append-only: never edit a shipped migration.
 * ta_session gets active_team_id, ta_invitation gets team_ids, and
 * ta_api_token gets the scope, the window, the quota, and the retired mark.
 * Each new column is nullable with no default and no fill. A row of version
 * 12 holds NULL: no team, no scope, no window, no quota, and a live token.
 * The five new tables hold the stored roles, the teams, the team members,
 * the organization tokens, and the record of each moved key. The tables
 * ta_organization_token and ta_moved_token have no user_id column, so the
 * account delete keeps their rows. The counts are
 * integer, not bigint: `postgresColumnType` gives bigint to `counter` and
 * `lastStep` only (ruling 9 of plan 12k). The runner applies the text in one
 * transaction. The columns keep the field order of the schema.
 */
export const name = "0013_schema_v13";
export const sql = `
ALTER TABLE ta_session ADD COLUMN active_team_id text;
ALTER TABLE ta_invitation ADD COLUMN team_ids jsonb;
ALTER TABLE ta_api_token ADD COLUMN permissions jsonb;
ALTER TABLE ta_api_token ADD COLUMN metadata jsonb;
ALTER TABLE ta_api_token ADD COLUMN rate_limit_seconds integer;
ALTER TABLE ta_api_token ADD COLUMN rate_limit_max integer;
ALTER TABLE ta_api_token ADD COLUMN remaining integer;
ALTER TABLE ta_api_token ADD COLUMN refill_amount integer;
ALTER TABLE ta_api_token ADD COLUMN refill_seconds integer;
ALTER TABLE ta_api_token ADD COLUMN last_refill_at timestamptz;
ALTER TABLE ta_api_token ADD COLUMN retired_at timestamptz;
CREATE TABLE ta_organization_role (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  name text NOT NULL,
  rank integer NOT NULL,
  permissions jsonb NOT NULL
);
CREATE UNIQUE INDEX ux_ta_organization_role__organization_id__name ON ta_organization_role (organization_id, name);
CREATE TABLE ta_team (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  name text NOT NULL
);
CREATE INDEX ix_ta_team__organization_id ON ta_team (organization_id);
CREATE TABLE ta_team_member (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  team_id text NOT NULL,
  organization_id text NOT NULL,
  user_id text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_team_member__team_id__user_id ON ta_team_member (team_id, user_id);
CREATE INDEX ix_ta_team_member__user_id ON ta_team_member (user_id);
CREATE INDEX ix_ta_team_member__organization_id__user_id ON ta_team_member (organization_id, user_id);
CREATE TABLE ta_organization_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  created_by_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  hint text NOT NULL,
  permissions jsonb NOT NULL,
  metadata jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  rate_limit_seconds integer,
  rate_limit_max integer,
  remaining integer,
  refill_amount integer,
  refill_seconds integer,
  last_refill_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_organization_token__token_hash ON ta_organization_token (token_hash);
CREATE INDEX ix_ta_organization_token__organization_id ON ta_organization_token (organization_id);
CREATE TABLE ta_moved_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  token_id text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_moved_token__source__source_id ON ta_moved_token (source, source_id);

UPDATE ta_meta SET value = '13' WHERE key = 'schema_version';
`;
