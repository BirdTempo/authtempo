# @authtempo/adapter-postgres

The storage adapter for Postgres through postgres.js (`postgres` 3.4.9 or newer, a peer dependency).

```ts
import { createAuth } from "@authtempo/core";
import { applyPostgresMigrations, createPostgresAdapter } from "@authtempo/adapter-postgres";
import postgres from "postgres";

const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, fetch_types: false });
await applyPostgresMigrations(sql);     // on deploy, not on every request
const auth = createAuth({ ...config, storage: createPostgresAdapter(sql) });
```

## On Cloudflare Workers

Set `compatibility_flags: ["nodejs_compat"]` and connect through Hyperdrive
with `max: 1`, `prepare: false`, and `fetch_types: false`. Create the
client per request and call `sql.end({ timeout: 5 })` when the request ends.

With `max: 1`, a write outside an open transaction waits for that
transaction's connection. The engine itself never does this. Since plan 9d
(amended 2026-10-13 by the plan 9d final fix wave), a before hook runs the
app's code inside the engine's open transaction, so the app's hook decides:
a before hook that queries this client with `max: 1` hangs the request until
the client ends: postgres.js 3.4.9 has no default queue timeout. If your own code does this, in a hook or elsewhere, use
`max: 2` or more, or a second client.
`test/hook-one-connection.test.ts` pins the hang with a pool of one and
the pass with a pool of two (plan 9h).

The adapter has not yet run on workerd through Hyperdrive in this repo.
Its first Workers consumer proves that run.

## Migrations

`applyPostgresMigrations(sql)` creates `ta_migrations` and runs every
migration it does not list yet, each in its own transaction. It is safe
to run on every deploy, also from two replicas at once. Each migration
transaction first takes an advisory lock and then reads the applied names
again. A second runner waits for the first and then skips the migrations
that the first applied. `MIGRATIONS` exposes the SQL text for review.

The adapter reads `ta_meta.schema_version` once. If it is older than the
core's `SCHEMA_VERSION` or missing, every operation throws `StorageError`
with code `schema_mismatch` until the migrations run. Only a missing
`ta_meta` table (SQLSTATE 42P01) counts as a missing version. Any other
read error passes through unchanged, and the next operation reads again.

Version 2 (plan 6, 2026-10-09) adds `ta_organization`, `ta_member`, and `ta_invitation`. Apply `0002_schema_v2` before you deploy a core at version 2; the adapter refuses a database at version 1.

Version 3 (plan 6b, 2026-10-10) adds `ta_limit` for the owned limiter (with the index `ix_ta_limit__expires_at` for its sweep) and the index `ix_ta_session__active_organization_id`. Apply `0003_schema_v3` before you deploy a core at version 3; the adapter refuses a database at version 2.

Version 4 (plan 8, 2026-10-10) adds `ta_password`, one row per user, with a unique index on the user. Apply `0004_schema_v4` before you deploy a core at version 4; the adapter refuses a database at version 3.

Version 5 (plan 8b, 2026-10-11) adds `ta_api_token`, one row per API token, with a unique index on the token hash and an index on the user. Apply `0005_schema_v5` before you deploy a core at version 5; the adapter refuses a database at version 4.

Version 6 (plan 9f, 2026-10-13) adds `ta_totp`, one row per user with a second factor (unique on the user), and `ta_trusted_device`, one row per trusted device, with a unique index on the token hash and an index on the user. Apply `0006_schema_v6` before you deploy a core at version 6; the adapter refuses a database at version 5.

Version 7 (plan 9g, 2026-10-13) adds `ta_jwk` (the signing keys, unique on `slot`), `ta_oauth_client`, `ta_oauth_consent` (unique on the client and the user), and `ta_oauth_token` (the refresh token hashes, unique on the hash, with indexes on the user, the family, and the client). Apply `0007_schema_v7` before you deploy a core at version 7; the adapter refuses a database at version 6.

Version 8 (plan 12c, 2026-10-14) adds `ta_second_factor`, one row per user with the second factor on (unique on the user), with the method list and the backup codes. It copies each enabled `ta_totp` row into it with the same id, so every stored backup code stays valid; `ta_totp.backup_codes` is unread from version 8 on. Apply `0008_schema_v8` before you deploy a core at version 8; the adapter refuses a database at version 7.

Warning: a Worker at version 7 still runs between the migration and the deploy. Its second-factor writes do not reach `ta_second_factor`. Deploy core at version 8 at once after `0008_schema_v8`. Then run the three checks below immediately after the deploy. Each check lists the users that need a fix.

```sql
-- 1. Enabled in the window: no factor row. Copy the ta_totp row with the same id, as 0008 does.
SELECT t.user_id FROM ta_totp t
WHERE t.enabled_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ta_second_factor s WHERE s.user_id = t.user_id);
-- 2. Disabled in the window: the factor lists totp with no enabled totp row. Run api.totp.disable({ userId }).
SELECT s.user_id FROM ta_second_factor s
WHERE s.methods ? 'totp'
  AND NOT EXISTS (SELECT 1 FROM ta_totp t WHERE t.user_id = s.user_id AND t.enabled_at IS NOT NULL);
-- 3. Codes spent or replaced in the window (run before core 8 spends a code): copy t.backup_codes into s.
SELECT s.user_id FROM ta_second_factor s JOIN ta_totp t ON t.id = s.id
WHERE s.backup_codes_version = 1 AND t.backup_codes <> s.backup_codes;
```

Version 9 (plan 12b, 2026-10-15) adds `secret_version` to `ta_totp`, `ta_second_factor`, `ta_verification`, and `ta_jwk`: the version of the app secret that seals or keys the value of the row, `NOT NULL DEFAULT 1`. Every row of today reads as version 1. Apply `0009_schema_v9` before you deploy a core at version 9; the adapter refuses a database at version 8. A Worker at version 8 that still runs after the migration writes the default 1. That is correct while the app has one secret: add a second secret version only after every Worker runs core at version 9.

Version 10 (plan 12a, 2026-10-15) adds `fresh_at` to `ta_session`: the time a sign-in or a re-authentication last proved the person. It is nullable, with no default and no fill. A session of version 9 holds null, and null is never fresh, so that session re-authenticates once before its first sensitive change. Apply `0010_schema_v10` before you deploy a core at version 10; the adapter refuses a database at version 9.

Version 11 (plan 12e, 2026-10-19) is the OAuth provider's second version. It adds the columns of a confidential client to `ta_oauth_client`, `parent_id` and `dpop_jkt` to `ta_oauth_token`, and the tables `ta_oauth_device`, `ta_oauth_subject`, `ta_oauth_session_client`, and `ta_oauth_logout`. Each new NOT NULL client column has a default, so each client row of version 10 reads as the public client it was. Apply `0011_schema_v11` before you deploy a core at version 11; the adapter refuses a database at version 10.

Version 12 (plan 12f, 2026-10-20) is the operator tools. It adds `banned_at`, `ban_reason`, and `ban_until` to `ta_user`, `actor_id` to `ta_session`, and the table `ta_operator_audit`. Each new column is nullable, with no default and no fill: a row of version 11 holds null, which means no ban and no impersonation. Apply `0012_schema_v12` before you deploy a core at version 12; the adapter refuses a database at version 11.

Version 13 (plan 12k, 2026-10-20) is organizations and tokens, second version. It adds `active_team_id` to `ta_session`, `team_ids` to `ta_invitation`, and nine columns to `ta_api_token`: the scope, the window, the quota, and the retired mark. It adds the tables `ta_organization_role`, `ta_team`, `ta_team_member`, `ta_organization_token`, and `ta_moved_token`, the record of each moved key. Each new column is nullable, with no default and no fill: a row of version 12 reads as before. Apply `0013_schema_v13` before you deploy a core at version 13; the adapter refuses a database at version 12.

Version 14 (plan 12d, 2026-10-21) is enterprise SSO and SCIM. It adds the tables `ta_sso_connection`, `ta_sso_domain`, `ta_scim_token`, `ta_scim_user`, `ta_scim_group`, and `ta_scim_group_member`. It changes no table of version 13: a row of version 13 reads as before. Apply `0014_schema_v14` before you deploy a core at version 14; the adapter refuses a database at version 13.

## Limiter

The memory limiter is per isolate; this one is the limit the product owns.
On Workers every isolate has its own memory limiter, so the real limit is
the configured limit times the isolate count. `createPostgresLimiter` keeps one count
per key and window in `ta_limit` (schema version 3) for every caller:

```ts
const auth = createAuth({ ...config, limiter: createPostgresLimiter(sql) });
```

Each call runs one statement. It inserts the key at count 1, or on a
conflict resets the window when it has ended, else adds 1, and returns the
count. The call passes when the count is at most `max`. The upsert locks the row, so two concurrent calls cannot both see `max - 1`.
The stored key is the key, the seconds, and the max, joined by U+001F
(the unit separator). A key with `|` is an ordinary key. A key with U+001F
throws an `Error`: no caller value can carry it, and it would alias
another window.

Each row carries `expires_at`, the window start plus the window. The
limiter's `sweep(now)` deletes every row whose window ended and answers
the count. `auth.api.sweepExpired()` calls it and reports it as `limits`.
Without a scheduled sweep, `ta_limit` keeps one row for every key and
window that ever reached the limiter.

## Transactions

A transaction is `BEGIN` and `COMMIT` on one reserved connection. A
nested transaction is a savepoint. If the nested function throws, only
the savepoint rolls back, and the outer transaction can catch the error
and continue. Concurrent transactions that read and then create the same
unique value leave one row. The loser gets `unique_violation`.

## Tests

`docker compose up -d` at the repo root, then
`pnpm --filter @authtempo/adapter-postgres test`. Each test gets a fresh
schema. The tests fail, never skip, when Postgres is not reachable.
