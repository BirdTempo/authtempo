/**
 * tempo-auth schema version 3 for Postgres: the owned limiter. Append-only:
 * never edit a shipped migration. ta_limit is not a core model: only the
 * limiter reads and writes it. window_start is bigint epoch milliseconds,
 * not timestamptz, so the limiter's one conditional statement compares
 * integers on both dialects. count is bigint so it cannot overflow.
 */
export const name = "0003_schema_v3";
export const sql = `
CREATE TABLE ta_limit (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count bigint NOT NULL
);

CREATE INDEX ix_ta_session__active_organization_id ON ta_session (active_organization_id);

UPDATE ta_meta SET value = '3' WHERE key = 'schema_version';
`;
