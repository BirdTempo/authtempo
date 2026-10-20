# @authtempo/adapter-d1

The storage adapter for Cloudflare D1. No Node dependency and no compatibility flag.

```ts
import { createAuth } from "@authtempo/core";
import { createD1Adapter } from "@authtempo/adapter-d1";

const auth = createAuth({ ...config, storage: createD1Adapter(env.DB) });
```

## Migrations

Point wrangler at this package's migrations and apply them:

```jsonc
// wrangler.jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "my-app",
  "database_id": "...",
  "migrations_dir": "node_modules/@authtempo/adapter-d1/migrations"
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
WHERE EXISTS (SELECT 1 FROM json_each(s.methods) WHERE json_each.value = 'totp')
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
Checked 2026-10-10: the Cloudflare page "D1 limits"
(<https://developers.cloudflare.com/d1/platform/limits/>) says each D1
database "processes queries one at a time". The race and burst tests in
`test/limiter.test.ts` are the local evidence.
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

WARNING: Inside `transaction`, do not delete a row whose child rows a foreign
key deletes with `ON DELETE CASCADE`. SQLite deletes the child rows itself,
so the undo log holds no entry for them, and a rollback restores the parent
row without its children. Delete the child rows first, then the parent, as
core's organization delete does. Core's own tables have no foreign key; the
Better Auth tables of `@authtempo/compat-better-auth` have seven, and app
code that uses `createD1AdapterOn` on them must follow this rule (plan 9b2).

## Tests

`pnpm --filter @authtempo/adapter-d1 test` runs the core conformance
suite on a real D1 through the Workers test pool, with the migration
applied by `applyD1Migrations`.
