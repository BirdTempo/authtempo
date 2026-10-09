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
with code `schema_mismatch` until the migrations run. Only a missing
`ta_meta` table counts as a missing version. Any other read error passes
through unchanged, and the next operation reads again.

Version 2 (plan 6, 2026-10-09) adds `ta_organization`, `ta_member`, and `ta_invitation`. Apply `0002_schema_v2` before you deploy a core at version 2; the adapter refuses a database at version 1.

Version 3 (plan 6b, 2026-10-10) adds `ta_limit` for the owned limiter (with the index `ix_ta_limit__expires_at` for its sweep) and the index `ix_ta_session__active_organization_id`. Apply `0003_schema_v3` before you deploy a core at version 3; the adapter refuses a database at version 2.

## Limiter

The memory limiter is per isolate; this one is the limit the product owns.
On Workers every isolate has its own memory limiter, so the real limit is
the configured limit times the isolate count. `createD1Limiter` keeps one count
per key and window in `ta_limit` (schema version 3) for every caller:

```ts
const auth = createAuth({ ...config, limiter: createD1Limiter(env.DB) });
```

Each call runs one statement. It inserts the key at count 1, or on a
conflict resets the window when it has ended, else adds 1, and returns the
count. The call passes when the count is at most `max`. D1 runs one statement at a time, so two concurrent calls cannot both see `max - 1`.
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

D1 has no interactive transaction. The adapter keeps an undo log in
memory: one entry for each write in the transaction. If the function
throws, the adapter rolls back the transaction: it runs the undo log in
reverse order. The rollback affects only the writes of this transaction.

A transaction is not isolated from other requests. Another request can
read a row that a later rollback removes. A rollback restores the row
that this transaction saw. The engine's real guards are unique keys and
conditional updates.

In a transaction, `update` runs its prior read and its write in one
atomic D1 batch, and `delete` uses `RETURNING`. So a rollback never
overwrites a write that landed between the read and the write. A write
that lands after this transaction's own write and before its rollback is
still overwritten.

A nested transaction adds its entries to the same undo log. If the nested
function throws, the rollback affects only the entries of the nested
transaction. The outer transaction can catch the error and continue.

If an undo entry fails, the adapter still runs the other entries. It then
throws `StorageError` with code `rollback_failed`. Its `cause` holds
`{ original, failures }`. The adapter does not throw the original error
in this case, so a failed rollback never looks like a normal unique
conflict.

An isolate that stops during a transaction never rolls back, because the
undo log lives in memory. The writes made before the stop stay. Until
plan 3 lands, sign-in can leave a user row without its email identity,
and no later sign-in creates it. Plan 3 repairs this: it creates the
missing email identity when the user exists.

## Tests

`pnpm --filter @tempo-auth/adapter-d1 test` runs the core conformance
suite on a real D1 through the Workers test pool, with the migration
applied by `applyD1Migrations`.
