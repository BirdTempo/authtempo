---
title: authtempo generate
description: Print the schema of the authtempo tables as SQL, as a Drizzle schema, or as Prisma models, for SQLite, Postgres, or MySQL.
type: reference
sources:
  - packages/cli/src/commands/generate.ts
  - packages/cli/src/help/generate.ts
  - packages/cli/src/generate/header.ts
  - packages/cli/src/generate/sql.ts
  - packages/cli/src/generate/drizzle.ts
  - packages/cli/src/generate/prisma.ts
  - docs/superpowers/plans/2026-10-14-12g-adapters-and-generate.md "Task 7"
sidebar:
  order: 29
---

**For:** a developer whose app reads the authtempo tables through an ORM, or who reviews the tables before the first migration.

**What it does:** this page lists the three formats of `authtempo generate`, its flags, its JSON document, and what the output never holds.

## Before you start

- The CLI, built from this repo. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.
- The tables stay the tables of authtempo. Create and change them with [authtempo migrate](/docs/reference/cli/migrate/).

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo generate --format sql --dialect postgres
authtempo generate --format drizzle --dialect sqlite --out src/authtempo-schema.ts
authtempo generate --format prisma --dialect mysql
```

| Flag | What it does |
| --- | --- |
| `--format sql`, `--format drizzle`, `--format prisma` | The form of the output. It has no default. |
| `--dialect sqlite`, `--dialect postgres`, `--dialect mysql` | The database of the output. It has no default. A D1 app applies the files of `@authtempo/adapter-d1` with wrangler. |
| `--out <file>` | Writes the output to a new file. The command writes no file over a file or a link. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The output is printed or written. |
| 2 | A usage error, or the file of --out exists. |

`--dialect d1` is a usage error. It names `--dialect sqlite`, because D1 runs the SQLite dialect.

## The three formats

Each output starts with one header line. The line holds the schema version, the dialect, the CLI version, and the rule: authtempo owns these tables. Write rows through the engine only. The output is for reads: a write through the ORM skips the guards of the engine.

1. **SQL.** The statements that make each table, key, and index on an empty database, then the records of the migration runner. After the apply, `authtempo migrate` finds nothing to do. The shape suite of each adapter proves that these statements and the shipped migrations make the same database.
2. **Drizzle.** One table per model, such as `taUser`, with the table, column, key, and index names of the database. A date reads as a `Date`, a boolean as a boolean, and JSON as an object. Keep the file out of the schema glob of `drizzle.config.ts`. Set `tablesFilter` to the tables of the app, so `drizzle-kit push` leaves the authtempo tables alone.
3. **Prisma.** One model per table, such as `TaUser`, with `@@map`, `@map`, and the names of each key and index. The header gives the `prisma.config.ts` keys of externally managed tables, a Preview feature of Prisma 7.10. On SQLite and MySQL, a date is a `BigInt` of epoch milliseconds. On SQLite, JSON is a `String`.

The Drizzle and Prisma files mark each column that holds a sealed value or a hash, such as `totp.secret` or `session.tokenHash`.

## The JSON

| Key | What it holds |
| --- | --- |
| `format` | The format of the run: `sql`, `drizzle`, or `prisma`. |
| `dialect` | The dialect of the run: `sqlite`, `postgres`, or `mysql`. |
| `schemaVersion` | The schema version of the core that the CLI bundles. |
| `out` | The path of the file that `--out` wrote, or null. |
| `text` | The output, or null when `--out` wrote it to a file. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop or a usage error holds the empty values of each key, `exit: 2`, and the reason in `stopped`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## What the output never holds

- No value of a variable. The command reads no environment variable.
- No host, user, or password. The command opens no connection.
- No row of a database. The output holds the shape of the tables only.

## Next

- [authtempo migrate](/docs/reference/cli/migrate/)
- [Schema and migrations](/docs/reference/schema/)
- [The CLI](/docs/reference/cli/)
