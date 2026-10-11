-- tempo-auth compat migration 0002 (plan 8b): core schema version 5.
-- Append-only. Core 5 adds API tokens, which this package does not map, so
-- no table changes. Apply it after 0001 for every naming and both variants:
-- it touches ta_meta only.
UPDATE ta_meta SET value = '5' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '2' WHERE key = 'compat_better_auth';
