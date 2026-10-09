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
to run on every deploy. `MIGRATIONS` exposes the SQL text for review.

The adapter reads `ta_meta.schema_version` once. If it is older than the
core's `SCHEMA_VERSION` or missing, every operation throws `StorageError`
with code `schema_mismatch` until the migrations run.

## Transactions

A transaction is `BEGIN` and `COMMIT` on one reserved connection. A
nested transaction is a savepoint. Concurrent transactions that read and
then create the same unique value leave one row; the loser gets
`unique_violation`.

## Tests

`docker compose up -d` at the repo root, then
`pnpm --filter @tempo-auth/adapter-postgres test`. Each test gets a fresh
schema. The tests fail, never skip, when Postgres is not reachable.
