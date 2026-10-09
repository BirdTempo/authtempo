# @tempo-auth/adapter-postgres

The storage adapter for Postgres through postgres.js (`postgres` 3.4.9 or newer, a peer dependency).

```ts
import { createAuth } from "@tempo-auth/core";
import { applyPostgresMigrations, createPostgresAdapter } from "@tempo-auth/adapter-postgres";
import postgres from "postgres";

const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, fetch_types: false });
await applyPostgresMigrations(sql);     // on deploy, not on every request
const auth = createAuth({ /* ... */, storage: createPostgresAdapter(sql) });
```

## On Cloudflare Workers

Set `compatibility_flags: ["nodejs_compat"]` and connect through Hyperdrive
with `max: 1`, `prepare: false`, and `fetch_types: false`. Create the
client per request and call `sql.end({ timeout: 5 })` when the request ends.

With `max: 1`, a write outside an open transaction waits for that
transaction's connection. The engine never does this. If your own code
does, use `max: 2` or more.

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

Version 3 (plan 6b, 2026-10-10) adds `ta_limit` for the owned limiter and the index `ix_ta_session__active_organization_id`. Apply `0003_schema_v3` before you deploy a core at version 3; the adapter refuses a database at version 2.

## Limiter

The memory limiter is per isolate; this one is the limit the product owns.
On Workers every isolate has its own memory limiter, so the real limit is
the configured limit times the isolate count. `createPostgresLimiter` keeps one count
per key and window in `ta_limit` (schema version 3) for every caller:

```ts
const auth = createAuth({ /* ... */, limiter: createPostgresLimiter(sql) });
```

Each call runs one statement. It inserts the key at count 1, or on a
conflict resets the window when it has ended, else adds 1, and returns the
count. The call passes when the count is at most `max`. The upsert locks the row, so two concurrent calls cannot both see `max - 1`.
A key must not contain `|`: the stored key is `${key}|${seconds}|${max}`,
so the limiter throws an `Error` on such a key.

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
