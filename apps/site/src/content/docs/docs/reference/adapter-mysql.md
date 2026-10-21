---
title: The MySQL adapter
description: Every export of @authtempo/adapter-mysql, the storage adapter and the limiter on MySQL 8.4 and later.
type: reference
sources:
  - packages/adapter-mysql/README.md "Checks at start"
  - packages/adapter-mysql/src/index.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 28
  - docs/superpowers/plans/2026-10-14-12g-adapters-and-generate.md "Task 9"
---

**For:** a developer who wires `@authtempo/adapter-mysql` into an app, or who reads its exports.

**What it does:** this page lists every export of the package. The export check holds the table to `packages/adapter-mysql/src/index.ts`.

## Before you start

- Read [Run authtempo on MySQL](/docs/guides/mysql/) for the steps, the checks at start, and the length bounds.

## Exports

| Export | What it is |
| --- | --- |
| `createMysqlAdapter` | The storage port on MySQL, from a mysql2 pool. The first call runs the four checks at start. Its `ping` reads the schema version with no cache, for `GET /auth/ready`. |
| `createMysqlAdapterOn` | The adapter with other statements, another error map, or other checks at start. |
| `MysqlAdapterOptions` | The options of `createMysqlAdapterOn`. |
| `toStorageError` | Maps a mysql2 error to a `StorageError`, or answers null. It copies no part of the driver message. |
| `createMysqlLimiter` | The owned limiter on MySQL, from a mysql2 pool. It keeps its counts in `ta_limit`. |
| `applyMysqlMigrations` | Applies each step that `ta_migrations` lacks, under the named lock `authtempo_migrations`, and answers the names that it changed. |
| `MYSQL_MIGRATIONS` | The migrations, in order. Each one is a list of statements. |
| `MysqlMigration` | One migration: its name and its statements. |
| `MYSQL_MIGRATIONS_TABLE_SQL` | The statement that makes `ta_migrations`. `authtempo generate` prints this text. |
| `expectedMysqlShape` | The tables, columns, and indexes that the migrations make. |
| `readMysqlShape` | Reads the live tables, columns, and indexes of a database. |
| `mysqlStartChecks` | The four checks at start: the version, FOUND_ROWS, strict mode, and the collations. |
| `mysqlSchemaVersionPing` | The `ping` of the adapter: the read of the schema version with no cache, each call. It throws `schema_mismatch` for a missing or old version. |

## Next

- [Run authtempo on MySQL](/docs/guides/mysql/)
- [Schema and migrations](/docs/reference/schema/#mysql-column-types)
