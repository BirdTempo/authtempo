# @authtempo/adapter-mysql

The authtempo storage adapter and limiter on MySQL 8.4 LTS and later, through
a mysql2 pool (3.24.5 or later) that the app opens. MariaDB is not supported.

```ts
import { createMysqlAdapter, createMysqlLimiter } from "@authtempo/adapter-mysql";
import { createPool } from "mysql2/promise";

const pool = createPool({ uri: process.env.DATABASE_URL, timezone: "Z" });
const storage = createMysqlAdapter(pool);
const limiter = createMysqlLimiter(pool);
```

## Checks at start

The first call of the adapter runs four checks, in this order. A pass is
kept. A failure is not kept, so the next call checks again. Each message
names the setting, never a value.

1. The schema version in `ta_meta`. A database with no `ta_meta` (MySQL
   error 1146) answers `schema_mismatch`: run the migrations. Any other error,
   such as a refused connection, passes through as it is.
2. FOUND_ROWS. An update that writes the same value must count the row. Else
   `config_mismatch`: "the pool reports changed rows, not matched rows; keep
   the mysql2 flag FOUND_ROWS". mysql2 sets the flag by default. Do not set
   `flags: ["-FOUND_ROWS"]`.
3. Strict mode. Else `config_mismatch`: "the session has no strict mode; set
   sql_mode to include STRICT_TRANS_TABLES". Without it MySQL cuts a long
   value and stores it.
4. The binary collation `utf8mb4_0900_bin` of each `ta_` table. Else
   `config_mismatch`, with each table and its collation. A case-blind
   collation makes two credential ids that differ only in case one key.

`readyStatements()` answers 4 after a pass.

## Transactions

`transaction(fn)` takes one pool connection, runs `SET TRANSACTION ISOLATION
LEVEL READ COMMITTED` and `START TRANSACTION`, and commits, or rolls back and
throws again. A nested call is a savepoint. This is the Postgres model, not
the D1 undo log. READ COMMITTED is load-bearing: a count after a lock of the
parent row must see the commit of the other caller.

- Do not query the pool from a hook inside a flow when the pool has one
  connection. The transaction holds that connection, so the hook waits
  forever (`test/hook-one-connection.test.ts`).
- `lockInOrder` reads the ids, then locks them by id on the primary key: two
  statements. InnoDB locks rows in the order of the index that it reads.
- A statement outside a transaction that InnoDB ends in a deadlock (1213) is
  sent again, at most three times. A deadlock in a transaction ends the
  transaction, and the error passes through.
- The lock order of the kinds (plan 12k) is held on Postgres only: the check
  records the port calls above the adapter, so a MySQL run gives the same
  verdict. The races `lock-order-races`, `organization-races`,
  `member-removal-team-races`, `team-delete-gap-race`,
  `organization-delete-gap-race`, and `team-role-loss-races` also stay on
  Postgres: each one locks rows by id, where InnoDB and Postgres take the
  same lock. The MySQL tests hold the account races, the one-connection
  flows, the quota race, the token cap, and the team races.

## Migrations

Run `applyMysqlMigrations(pool)` at deploy, or `authtempo migrate --target
mysql`. MySQL starts at the baseline `0001_schema_v13`: no MySQL database
held an older version. MySQL commits each DDL statement at once, so the
runner records each statement as a step in `ta_migrations` and resumes at the
next step after a failure. The last step writes the version. The runner takes
the named lock `authtempo_migrations` for 60 s, on one connection. A MySQL
named lock belongs to the server, so two databases on one server share it.

## Workers through Hyperdrive

mysql2 3.13.0 or later, `disableEval: true`, and Node.js compatibility
(`nodejs_compat`). `proof/bundle.mjs` bundles a Worker with wrangler and runs
it in workerd through wrangler dev. That is a proof of the bundle, not a
deploy.

## Length bounds

A string field that a key or an index holds has a width on MySQL only (the
table `MYSQL_STRINGS` of `@authtempo/core/ddl`). Any other string is `TEXT`.
A value that D1 and Postgres store fails here with `invalid_argument`
(MySQL error 1406). `test/bounds.test.ts` holds each row at its bound.

An ascii column holds printable ASCII (U+0020 to U+007E) with no trailing
space. MySQL answers a non-ASCII value there with error 3988, and `ascii_bin`
ignores trailing spaces. So a write of another value answers
`invalid_argument` on MySQL only: D1, Postgres, and SQLite store it. A where
clause with such a value answers as Postgres and D1 do, by byte order
(`src/ascii-guard.ts`). Core's conformance suite holds that answer on every
store (ruling 9 of plan 12g).

## MariaDB

Not supported: it has no `utf8mb4_0900_bin`, and its RETURNING and JSON
differ.
