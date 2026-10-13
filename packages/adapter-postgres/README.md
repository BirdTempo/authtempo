# @tempo-auth/adapter-postgres

The storage adapter for Postgres through postgres.js (`postgres` 3.4.9 or newer, a peer dependency).

```ts
import { createAuth } from "@tempo-auth/core";
import { applyPostgresMigrations, createPostgresAdapter } from "@tempo-auth/adapter-postgres";
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
`pnpm --filter @tempo-auth/adapter-postgres test`. Each test gets a fresh
schema. The tests fail, never skip, when Postgres is not reachable.
