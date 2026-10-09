# @tempo-auth/adapter-d1

The storage adapter for Cloudflare D1. No Node dependency and no compatibility flag.

```ts
import { createAuth } from "@tempo-auth/core";
import { createD1Adapter } from "@tempo-auth/adapter-d1";

const auth = createAuth({ /* ... */, storage: createD1Adapter(env.DB) });
```

## Migrations

Point wrangler at this package's migrations and apply them:

```jsonc
// wrangler.jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "my-app",
  "database_id": "...",
  "migrations_dir": "node_modules/@tempo-auth/adapter-d1/migrations"
}]
```

```bash
wrangler d1 migrations apply my-app
```

The adapter reads `ta_meta.schema_version` once. If it is older than the
core's `SCHEMA_VERSION` or missing, every operation throws `StorageError`
with code `schema_mismatch` until the migrations run.

## Transactions

D1 has no interactive transaction. A transaction runs its statements at
once and reverses its own writes if the function throws. It is not
isolated from other requests: another request can read a row this
transaction later reverses, and a rollback restores the row this
transaction saw. The engine's real guards are unique keys and conditional
updates. Nested transactions share the outer undo log. In a transaction,
`update` runs its prior read and its write in one atomic D1 batch, and
`delete` uses `RETURNING`, so a rollback never overwrites a write that
landed between the read and the write. A write that lands after this
transaction's own write and before its rollback is still overwritten.

## Tests

`pnpm --filter @tempo-auth/adapter-d1 test` runs the core conformance
suite on a real D1 through the Workers test pool, with the migration
applied by `applyD1Migrations`.
