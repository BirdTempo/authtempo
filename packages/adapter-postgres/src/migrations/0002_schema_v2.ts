/**
 * authtempo schema version 2 for Postgres: organizations. Append-only:
 * never edit a shipped migration. Names come from @authtempo/core/sql:
 * tables ta_<model>, columns snake_case, unique indexes
 * ux_<table>__<col>__<col>, indexes ix_<table>__<col>. The columns keep the
 * field order of the schema, because the D1 parity test checks that order.
 */
export const name = "0002_schema_v2";
export const sql = `
CREATE TABLE ta_organization (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  metadata jsonb
);
CREATE UNIQUE INDEX ux_ta_organization__slug ON ta_organization (slug);

CREATE TABLE ta_member (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_member__organization_id__user_id ON ta_member (organization_id, user_id);
CREATE INDEX ix_ta_member__user_id ON ta_member (user_id);

CREATE TABLE ta_invitation (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  organization_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  inviter_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_invitation__token_hash ON ta_invitation (token_hash);
CREATE INDEX ix_ta_invitation__organization_id__email ON ta_invitation (organization_id, email);

UPDATE ta_meta SET value = '2' WHERE key = 'schema_version';
`;
