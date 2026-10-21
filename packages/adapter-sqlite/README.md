# @authtempo/adapter-sqlite

The storage adapter and the limiter for SQLite on Node and Bun, and for a
remote libSQL database on Workers. It is the D1 adapter's code over a small
seam: every driver runs the D1 undo log and the D1 limiter.

```ts
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "@authtempo/core";
import { applySqliteMigrations, createSqliteAdapter, createSqliteLimiter } from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";

const db = new DatabaseSync("/var/lib/my-app/auth.sqlite");
db.exec("PRAGMA busy_timeout = 5000");
const driver = nodeSqlite(db);
await applySqliteMigrations(driver);

const auth = createAuth({
  ...config,
  storage: createSqliteAdapter(driver),
  limiter: createSqliteLimiter(driver),
});
```

## Transactions

SQLite through this adapter has no interactive transaction. The adapter
keeps an undo log in memory: one entry for each write in the transaction.
If the function throws, the adapter rolls back the transaction: it runs the
undo log in reverse order. The rollback affects only the writes of this
transaction.

A transaction is not isolated from other requests. Another request can
read a row that a later rollback removes. A rollback restores the row
that this transaction saw. The engine's real guards are unique keys and
conditional updates.

A process that stops during a transaction never rolls back, because the
undo log lives in memory. The writes made before the stop stay.

In a transaction, `update` runs its prior read and its write in one batch,
and `delete` uses `RETURNING`. So a rollback never overwrites a write that
landed between the read and the write. A write that lands after this
transaction's own write and before its rollback is still overwritten.

On the three synchronous drivers a batch is `BEGIN IMMEDIATE`, the
statements, and `COMMIT` in one synchronous block. On libSQL a batch is
`client.batch(statements, "write")`. No transaction stays open across an
`await`.

A nested transaction adds its entries to the same undo log. If the nested
function throws, the rollback affects only the entries of the nested
transaction. The outer transaction can catch the error and continue.

If an undo entry fails, the adapter still runs the other entries. It then
throws `StorageError` with code `rollback_failed`. Its `cause` holds
`{ original, failures }`. The adapter does not throw the original error
in this case, so a failed rollback never looks like a normal unique
conflict.

## Drivers

The app opens the database and passes the handle to the entry of its
driver. No entry imports a driver at run time: each entry imports the
driver's types only. So an app on Bun loads no better-sqlite3, and an app on
Workers loads only the libSQL module that it imports.

| Entry | Driver | Runtimes | Peer dependency |
| --- | --- | --- | --- |
| `@authtempo/adapter-sqlite/node` | `node:sqlite` | Node 22.13 or later | none |
| `@authtempo/adapter-sqlite/better-sqlite3` | better-sqlite3 13 | Node | `better-sqlite3` (optional) |
| `@authtempo/adapter-sqlite/bun` | `bun:sqlite` | Bun | none |
| `@authtempo/adapter-sqlite/libsql` | `@libsql/client` for `file:`, or `@libsql/client/web` for `http:`, `https:`, and `libsql:` | Node, Bun, Workers (remote only) | `@libsql/client` (optional) |

```ts
import Database from "better-sqlite3";
import { betterSqlite3 } from "@authtempo/adapter-sqlite/better-sqlite3";
const driver = betterSqlite3(new Database("auth.sqlite"));
```

```ts
import { Database } from "bun:sqlite";
import { bunSqlite } from "@authtempo/adapter-sqlite/bun";
const driver = bunSqlite(new Database("auth.sqlite"));
```

```ts
import { createClient } from "@libsql/client/web";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
const driver = libsql(createClient({ url: env.LIBSQL_URL, authToken: env.LIBSQL_AUTH_TOKEN }));
```

### The busy timeout of `node:sqlite`

Open a `node:sqlite` database with a busy timeout. Its default timeout is
0 ms. So a second process that writes to the same file gets "database is
locked" at once (read 2026-10-21, Node 26.10.0). Run
`PRAGMA busy_timeout = 5000` after you open the database. On a Node version
with the `timeout` option, you can pass `{ timeout: 5000 }` to
`DatabaseSync` instead. better-sqlite3 sets a busy timeout of 5000 ms by
default.

### The write lock of libSQL

A libSQL `batch()` has no busy retry. On a `file:` database, a batch
fails at once with `SQLITE_BUSY` while another connection holds the write
lock, for example a migration. The adapter passes that error through
unchanged, as a busy write does on D1. Only the migration step tries again
(probe 2026-10-21, `@libsql/client` 0.18.0).

Over HTTP the server makes a batch wait for the lock. The libSQL server
v0.24.32 ends a write transaction after 5 s with `TRANSACTION_TIMEOUT`. So
a process that dies inside a write transaction blocks other writes for
about 5 s. In the probe of 2026-10-21, the next write ran 3 s to 5 s after
the stop.

## Migrations

The SQLite migrations are the D1 files of `@authtempo/adapter-d1`, copied
into this package at build with a byte check. Bring the database to the
schema of this package at each start:

```ts
await applySqliteMigrations(driver);
```

Or run `authtempo migrate --target sqlite` before the start. The runner
records each name in `ta_migrations`. It runs each migration and its record
in one write transaction, so a second process waits for the write lock and
then skips the work.

The adapter reads `ta_meta.schema_version` once. If it is older than the
core's `SCHEMA_VERSION` or missing, every operation throws `StorageError`
with code `schema_mismatch` until the migrations run.

## Workers

| Driver | On Workers | Why |
| --- | --- | --- |
| D1 | yes | the platform's SQLite, `@authtempo/adapter-d1` |
| libSQL over `https:` or `libsql:` | yes | `@libsql/client/web` uses `fetch`. The `libsql` entry imports no Node module, and a bundle proof holds it. |
| libSQL over `file:` | no | `@libsql/client/web` refuses `file:` URLs |
| better-sqlite3, `node:sqlite` | no | a native module, or a Node built-in that workerd does not have |
| `bun:sqlite` | no | a Bun built-in |

On Workers, import `createClient` from `@libsql/client/web`. The proof
Worker of this package (`proof/worker`) bundles the `libsql` entry, the
adapter, and `@libsql/client/web` with Node.js compatibility off. The
bundle imports no Node module.

## The database file

The database holds sealed secrets and password hashes. Create the file with
mode 0600, outside the web root. Back it up as a secret.

## Settings the adapter refuses

The decode rules of core read integers as numbers. A handle that reads
integers as `BigInt` breaks dates, counts, and flags. The first call of the
adapter throws `StorageError` with code `config_mismatch` when the handle
has one of these settings:

- `node:sqlite`: `readBigInts: true`.
- better-sqlite3: `db.defaultSafeIntegers(true)`.
- `bun:sqlite`: `safeIntegers: true`.
- libSQL: `intMode: "bigint"`.

## Tests

`pnpm --filter @authtempo/adapter-sqlite test` runs the core suites on
`node:sqlite`, better-sqlite3, libSQL `file:`, libSQL over HTTP, and
`bun:sqlite`. The core suites are the storage conformance suite, the
limiter suite, the secret rotation suite, the two refresh race suites, and
the shape check. Then it
loads the `libsql` entry in workerd and runs the bundle proof. The HTTP run
needs the libSQL server: `docker compose up -d libsql`.
