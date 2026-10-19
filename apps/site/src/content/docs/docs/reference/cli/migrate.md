---
title: authtempo migrate
description: Apply the migrations of the installed adapter on Postgres or on D1, after a check of the schema version.
type: reference
sources:
  - packages/cli/README.md "migrate"
  - packages/adapter-d1/README.md "Migrations"
  - packages/adapter-postgres/README.md "Migrations"
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 6"
sidebar:
  order: 3
---

**For:** an operator who applies the migrations of a new version, or of a new database.

**What it does:** this page lists the targets of `authtempo migrate`, its version gate, and the rules of the D1 folder.

## Before you start

- A backup of the database. [Backups](/docs/operations/backups/) tells how.
- [Schema and migrations](/docs/reference/schema/) lists the schema versions.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo migrate --target postgres --url-env DATABASE_URL
authtempo migrate --target d1 --database my-app --remote
```

| Flag | What it does |
| --- | --- |
| `--target postgres` | Applies the Postgres migrations of `@authtempo/adapter-postgres`. |
| `--target d1` | Applies the D1 migrations through the wrangler of the project. |
| `--tables core` | Core's tables. This is the default. |
| `--tables compat` | The Better Auth 1.7 tables of `@authtempo/compat-better-auth`. |
| `--url-env <NAME>` | Postgres: the variable of the connection string. The default is `DATABASE_URL`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--url-file <path>` | Postgres: the file of the connection string. `-` is stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--database <name>` | D1: the `database_name` in the wrangler config. One D1 database needs no name. |
| `--config <path>` | D1: the wrangler config. The default is `wrangler.jsonc` or `wrangler.json` in the current folder. |
| `--remote` | D1: the database on Cloudflare. The default is the local database of `wrangler dev`. |
| `--before-1.7` | D1 with `--tables compat`: the files for tables from before Better Auth 1.7. |
| `-n`, `--dry-run` | Lists the migrations, and applies nothing. |
| `--json` | Prints `{ target, tables, dryRun, before, after, pending, applied, copied, exit, stopped }`. `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The database is at the schema version of this CLI, or the dry run listed the migrations. |
| 2 | A usage error, a newer database, a database that does not answer, an edited compat copy, or a migration that failed. |

## The version gate

1. The command reads the row `schema_version` of `ta_meta`. A missing table is no version.
2. A version above the version of the CLI stops the run with exit 2, before any write.
3. The command lists the migrations that the database lacks. A dry run stops here with exit 0.
4. The command applies them, and reads the version again.
5. It exits 0 only at the version of the CLI.

## Postgres

- `applyPostgresMigrations` applies the files. Its advisory lock makes two runs at once safe.
- The command uses one connection, and ends it before it exits.
- With `--tables compat`, the command runs the migrations of the compatibility package. That package refuses a schema with core's own `ta_meta` and `ta_limit`.
- With `--tables compat`, the command prints one warning when the project holds `better-auth` below 1.7.7. Upgrade it first.

## D1

- The command runs the wrangler of the project, from `node_modules/.bin`. The CLI ships no wrangler.
- With `--tables core`, the `migrations_dir` of the binding must hold each file of `@authtempo/adapter-d1` with the same text.
- Another folder stops the run, and the message names both folders. wrangler would apply the wrong files and report success.
- With `--tables compat`, the command copies each compat file into the `migrations_dir` of the app under its next number.
- The command reads `compat_better_auth` of `ta_meta` first. It copies no compat file that the database holds already, also when the app renamed its copy.
- The compat files hold the default table and column names of Better Auth. On tables with other names, the shipped 0001, 0006, and 0007 fail with `no such table`. Such an app writes 0001 from `storage.migrationSql()`, or from `storage.migrationSql("before-1.7")` for tables from before 1.7. It writes 0006 from `compatMigration0006Sql("sqlite", storage.names)`, and 0007 from `compatMigration0007Sql("sqlite", storage.names)`.
- With `--tables compat`, a `migrations_dir` in a package or under `node_modules` stops the run with exit 2, before the first write. The default folder of a core D1 app is that of `@authtempo/adapter-d1`, so point `migrations_dir` at a folder of the app first.
- A file whose text the folder holds already is not copied again.
- wrangler records each applied file in its table `d1_migrations`.
- With `--tables compat`, the command prints one warning when the project holds `better-auth` below 1.7.7. Upgrade it first.

:::caution
Warning: do not edit a copied compat file. The next run stops with exit 2 before any write, and names the file. Restore its text, and put the change in a new migration of the app.
:::

:::caution
Warning: do not deploy a new core before its migrations run. Every request then answers 500 until they run.
:::

## Next

- [Upgrades and schema versions](/docs/operations/upgrades/)
- [Schema and migrations](/docs/reference/schema/)
- [authtempo check](/docs/reference/cli/check/)
