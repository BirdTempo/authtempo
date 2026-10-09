-- tempo-auth schema version 3 for D1 (SQLite): the owned limiter. Append-only.
-- ta_limit is not a core model: only the limiter reads and writes it.
-- window_start is epoch milliseconds, the same as on Postgres, so the
-- limiter's one conditional statement compares integers on both dialects.

CREATE TABLE ta_limit (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- The organization routes find the sessions that name one organization.
CREATE INDEX ix_ta_session__active_organization_id ON ta_session (active_organization_id);

UPDATE ta_meta SET value = '3' WHERE key = 'schema_version';
