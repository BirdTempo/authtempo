---
title: authtempo migrate
description: Apply the migrations of the installed adapter on Postgres, D1, SQLite, or MySQL, after a check of the schema version.
type: reference
sources:
  - packages/cli/README.md "migrate"
  - packages/adapter-d1/README.md "Migrations"
  - packages/adapter-postgres/README.md "Migrations"
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
authtempo migrate --target sqlite --file ./auth.db
authtempo migrate --target mysql --url-env DATABASE_URL --dry-run
```

The third line creates or updates the tables in a SQLite file. The fourth line lists the migrations that a MySQL database lacks.

| Flag | What it does |
| --- | --- |
| `--target postgres` | Applies the Postgres migrations of `@authtempo/adapter-postgres`. |
| `--target d1` | Applies the D1 migrations through the wrangler of the project. |
| `--target sqlite` | Applies the SQLite migrations of `@authtempo/adapter-sqlite` to a file or to a libSQL server. |
| `--target mysql` | Applies the MySQL migrations of `@authtempo/adapter-mysql`. |
| `--tables core` | Core's tables. This is the default. |
| `--tables compat` | The Better Auth 1.7 tables of `@authtempo/compat-better-auth`, on Postgres, D1, or SQLite. MySQL refuses it. |
| `--url-env <NAME>` | Postgres and MySQL: the variable of the connection string. The default is `DATABASE_URL`. SQLite: the variable of a libSQL URL. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--url-file <path>` | Postgres, MySQL, and SQLite: the file of the connection string or the libSQL URL. `-` is stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--file <path>` | SQLite: the path of the database file. The command makes the file when it is missing, except with `--tables compat`. |
| `--auth-token-env <NAME>` | SQLite with a libSQL URL: the variable of the token. The default is `LIBSQL_AUTH_TOKEN`. With no such variable, the command sends no token. |
| `--auth-token-file <path>` | SQLite with a libSQL URL: the file of the token. `-` is stdin. |
| `--database <name>` | D1: the `database_name` in the wrangler config. One D1 database needs no name. |
| `--config <path>` | D1: the wrangler config. The default is `wrangler.jsonc` or `wrangler.json` in the current folder. |
| `--remote` | D1: the database on Cloudflare. The default is the local database of `wrangler dev`. |
| `--before-1.7` | D1 or SQLite with `--tables compat`: the migrations for tables from before Better Auth 1.7. |
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

## SQLite

- Give one of `--file`, `--url-env`, or `--url-file`. Two of them, or none, is a usage error.
- `--file` opens the file through `node:sqlite` (Node.js 22.13 and later). The command waits up to 5 seconds for the write lock of another process.
- A URL opens a libSQL server through `@libsql/client`. A host that is not a loopback address needs `https:`, `wss:`, or `libsql:` with TLS. A plain `http:` URL to such a host stops the run with exit 2, before any connection.
- The command reads the URL with the parser of `@libsql/client`, so it judges the host that the driver connects to. A URL with a backslash, or with a query key more than once, stops the run with exit 2.
- `--dry-run` on a missing file makes no file. Without `--tables compat`, it lists every migration as pending.
- On a file in WAL mode, `--dry-run` can leave the `-wal` and `-shm` files of SQLite beside it. The main file does not change. The CLI deletes neither file, because another connection can hold them.
- A file that is not empty and does not start with the SQLite header stops the run with exit 2, before any write. The command never writes over such a file.
- `applySqliteMigrations` applies the files, which are the D1 files of `@authtempo/adapter-d1`. Each file and its record in `ta_migrations` run in one write transaction.
- A driver error prints as `storage: <code> at <file>`, or at the host and the name of the URL. The command never prints the message of the driver, the token, or the query of the URL.
- With `--tables compat`, the command runs the compat migrations of `@authtempo/compat-better-auth` on the Better Auth tables of the database. Add `--before-1.7` for tables from before Better Auth 1.7.
- With `--tables compat`, a missing file stops the run with exit 2, and the command makes no file. The file must hold the Better Auth tables of the app.
- With `--tables compat`, a file with the tables of core stops the run with exit 2, before any write. The compat migrations make their own `ta_meta` and `ta_limit`. Use a file with the Better Auth tables of the app and no tables of core.
- Each compat migration and its record in `ta_migrations` run in one write transaction. The command skips each compat migration at or below `compat_better_auth` of `ta_meta`, so a database that the D1 files migrated goes on from there.
- On tables with other names, or with Better Auth's `teams` option, apply the app's own compat texts first, as the D1 section tells. Then the command skips them.
- With `--tables compat`, the command prints one warning when the project holds `better-auth` below 1.7.7. Upgrade it first.

## MySQL

- MySQL 8.4 and later. A host that is not a loopback address needs `?ssl={"rejectUnauthorized":true,"verifyIdentity":true}` in the URL. Without it, the run stops with exit 2, before any connection. Without `verifyIdentity`, mysql2 checks the certificate chain but not the host name.
- A host that is an IP address but not a loopback address stops the run with exit 2, even with that `ssl`. mysql2 sends no server name to an IP host, and it checks the name `localhost` in its place. Use the DNS name that the certificate carries.
- The URL takes the query keys `ssl` and `connectTimeout` only. Another key, or a key more than once, stops the run with exit 2, before any connection.
- `applyMysqlMigrations` applies the migrations. Its named lock makes two runs at once safe.
- The command uses one connection, and ends it before it exits.
- A driver error prints as `storage: <code> at <host:port/name>`, such as `storage: ER_ACCESS_DENIED_ERROR at db.example.com:3306/app`. The command never prints the message of the driver, which names the user.
- `--tables compat` is not served on MySQL. It is a usage error.

## D1

- The command runs the wrangler of the project, from `node_modules/.bin`. The CLI ships no wrangler.
- With `--tables core`, the `migrations_dir` of the binding must hold each file of `@authtempo/adapter-d1` with the same text.
- Another folder stops the run, and the message names both folders. wrangler would apply the wrong files and report success.
- With `--tables compat`, the command copies each compat file into the `migrations_dir` of the app under its next number.
- The command reads `compat_better_auth` of `ta_meta` first. It copies no compat file that the database holds already, also when the app renamed its copy.
- The compat files hold the default table and column names of Better Auth. On tables with other names, the shipped 0001, 0006, 0007, 0009, 0010, 0012, and 0013 fail with `no such table`.
- Such an app writes its own thirteen compat files. It copies 0002 to 0005, 0008, and 0011 as the package ships them. It writes 0001 from `storage.migrationSql()`, or from `storage.migrationSql("before-1.7")` for tables from before 1.7.
- It writes 0006 from `compatMigration0006Sql("sqlite", storage.names)`, and 0007 from `compatMigration0007Sql("sqlite", storage.names)`. It writes 0009 from `compatMigration0009Sql("sqlite", storage.names)`, and 0010 from `compatMigration0010Sql("sqlite", storage.names)`. For tables from before 1.7, `compatMigration0010Sql` takes `"before-1.7"` as a third argument. It writes 0012 from `compatMigration0012Sql("sqlite", storage.names)`, and 0013 from `compatMigration0013Sql("sqlite", storage.names)`.
- Tables that hold `session.activeTeamId` and `invitation.teamId` already (Better Auth's `teams` option) need an own 0010, also with the default names. It is the 0010 text without its two `ADD COLUMN` lines of `session` and `invitation`. Without it, the 0010 fails with `duplicate column name: activeTeamId`.
- Tables that hold the columns of Better Auth's username, phone number, or anonymous plugin need an own 0012. It is the 0012 text without the `ADD COLUMN` line of each column that they hold, and without the unique key that they hold.
- Such an app applies its own files with `wrangler d1 migrations apply <database>` before this command. Then the compat version is 13, and the command copies nothing. If not, the command stops on an own file with the name of a compat file. Or it copies the shipped 0001, which fails with `no such table`.
- With `--tables compat`, a `migrations_dir` in a package or under `node_modules` stops the run with exit 2, before the first write. The default folder of a core D1 app is that of `@authtempo/adapter-d1`, so point `migrations_dir` at a folder of the app first.
- A file whose text the folder holds already is not copied again.
- A copy that is not applied yet and has another text stops the run with exit 2, before any write. The line names the file.
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
