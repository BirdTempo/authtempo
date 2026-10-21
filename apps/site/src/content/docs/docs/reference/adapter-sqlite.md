---
title: The SQLite adapter
description: Every export of @authtempo/adapter-sqlite and of its four driver entries, and the D1 seam that the adapter runs on.
type: reference
sources:
  - packages/adapter-sqlite/README.md "Drivers"
  - packages/adapter-sqlite/src/index.ts
  - packages/adapter-d1/src/seam-entry.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 28
  - docs/superpowers/plans/2026-10-14-12g-adapters-and-generate.md "Task 9"
---

**For:** a developer who wires `@authtempo/adapter-sqlite` into an app, or who reads its exports.

**What it does:** this page lists every export of the five entries of the package and of `@authtempo/adapter-d1/seam`. The export check holds each table to the entry's source file.

## Before you start

- Read [Run authtempo on SQLite](/docs/guides/sqlite/) for the steps and the limits of the adapter.

## The main entry

`@authtempo/adapter-sqlite` holds the adapter, the limiter, the migrations, and the shape reads. It imports no driver.

| Export | What it is |
| --- | --- |
| `createSqliteAdapter` | The storage port on SQLite, from a `SqliteDriver`. The first call checks the integer reads, then the schema version. Its `ping` reads the schema version with no cache, for `GET /auth/ready`. |
| `createSqliteLimiter` | The owned limiter on SQLite, from a `SqliteDriver`. It keeps its counts in `ta_limit`. |
| `SqliteDriver` | One database through one driver. An entry of a driver makes it from the handle that the app opens. |
| `applySqliteMigrations` | Applies each migration that `ta_migrations` lacks, and answers the names that ran. It is safe on every start. |
| `SQLITE_MIGRATIONS` | The migrations, in order: the D1 files of `@authtempo/adapter-d1`, copied at build. |
| `SQLITE_MIGRATIONS_TABLE_SQL` | The statement that makes `ta_migrations`. `authtempo generate` prints this text. |
| `integerProbe` | The check that the handle reads an integer as a number. It throws `config_mismatch` on a `BigInt`. |
| `expectedSqliteShape` | The tables, columns, and indexes that the migrations make. |
| `readSqliteShape` | Reads the live tables, columns, and indexes of a database. |

## The node entry

| Export | What it is |
| --- | --- |
| `nodeSqlite` | A `SqliteDriver` over a `DatabaseSync` of `node:sqlite` (Node 22.13 or newer). |

## The better-sqlite3 entry

| Export | What it is |
| --- | --- |
| `betterSqlite3` | A `SqliteDriver` over a better-sqlite3 `Database`. |

## The bun entry

| Export | What it is |
| --- | --- |
| `bunSqlite` | A `SqliteDriver` over a `Database` of `bun:sqlite`. |

## The libsql entry

| Export | What it is |
| --- | --- |
| `libsql` | A `SqliteDriver` over a libSQL `Client`: a `file:` URL, or `https:` and `libsql:` through `@libsql/client/web`. |

## The D1 seam entry

`@authtempo/adapter-d1/seam` holds the D1 code with no Workers type. The SQLite adapter runs it over each driver.

| Export | What it is |
| --- | --- |
| `D1Subset` | The part of a D1 binding that the D1 code calls. A D1 binding satisfies it. |
| `D1SubsetStatement` | One prepared statement of a `D1Subset`. |
| `D1SubsetResult` | The rows of a statement and its count of changed rows. |
| `createD1AdapterOn` | The D1 adapter, with its undo log, over a `D1Subset`. |
| `D1AdapterOptions` | The statements, the error map, and the start check of `createD1AdapterOn`, with an optional statement count. |
| `createD1Limiter` | The D1 limiter over a `D1Subset`. |
| `schemaVersionCheckOn` | The check of `ta_meta.schema_version` over a `D1Subset`. |
| `schemaVersionPing` | The `ping` of an adapter over a `D1Subset`: the read of `ta_meta.schema_version` with no cache, each call. It throws `schema_mismatch` for an old version. |
| `toStorageError` | Maps a SQLite unique error to a `StorageError` with `unique_violation`, or answers null for another error. |

## Next

- [Run authtempo on SQLite](/docs/guides/sqlite/)
- [Schema and migrations](/docs/reference/schema/)
