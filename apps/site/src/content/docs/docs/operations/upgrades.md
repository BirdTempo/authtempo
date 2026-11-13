---
title: Upgrades and schema versions
description: Move an API to a newer authtempo, with the migrations of its schema version applied in the right order.
type: how-to
sources:
  - packages/core/README.md "Limits in version 1"
  - packages/adapter-d1/README.md "Migrations"
  - packages/adapter-postgres/README.md "Migrations"
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
sidebar:
  order: 4
---

**For:** an operator who moves an API to a newer version of the authtempo packages.

**What it does:** this guide applies the migrations before the new code runs, so no request meets an old database.

## Before you start

- A backup of the database. [Backups](/docs/operations/backups/) tells how.
- The schema version that the new core needs: `SCHEMA_VERSION`, listed on [Schema and migrations](/docs/reference/schema/).

## Steps

1. Read the changelog of the new version. [Changelog](/docs/changelog/) lists each release.
2. Update the `@authtempo` packages of the app to the same version. Keep one version of core in the app.
3. On D1, apply the migrations of the adapter to the real database.

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo migrate --target d1 --database my-app --remote
```

4. On Postgres, apply them once per deploy, before the first request.

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo migrate --target postgres --url-env DATABASE_URL
```

5. With the compatibility package, add `--tables compat` to the command of step 3 or step 4.
6. On D1, that command copies each new compat file under the next number of the app.
7. Deploy the new code.
8. Run `authtempo check` with the base URL of the API.
9. Sign in once by each method that the API serves.

## Upgrade with the CLI

`authtempo upgrade` does step 2 for you. It reads the `package.json` of the app and moves each `@authtempo` package to one version. It runs no install.

- When a crossed minor has a "Breaking:" line, the command prints the line and exits 1. It still writes the versions. Read each line and change your code before the install.
- When the schema version of the target core differs, the next steps name `authtempo migrate`. Run it as in step 3 or step 4, before the deploy.
- `authtempo upgrade --dry-run` prints the change and writes nothing.

[authtempo upgrade](/docs/reference/cli/upgrade/) lists each flag and each exit code. [Deprecations](/docs/reference/deprecations/) lists each item that a minor removes.

## How it behaves

- Each adapter reads `ta_meta.schema_version` once. An older or missing version makes every operation throw `StorageError` with `schema_mismatch`.
- The table prefix `ta_` keeps the old product name tempo-auth for compatibility. [Schema and migrations](/docs/reference/schema/) states the rule.
- A migration is append-only. A new version adds a migration and never changes an old one.
- A migration of a newer version runs safely under the older code. So apply it first, then deploy.
- `applyPostgresMigrations` is safe on every deploy, also from two replicas at once. Each migration takes an advisory lock and reads the applied names again.
- `wrangler d1 migrations apply` rolls back a file that fails, so a refused file changes nothing.
- Version 16 fills `ta_session.proved` in one statement. On D1 an app with more than 100,000 live sessions of verified users applies that fill by hand, in pages, before step 3. [Schema and migrations](/docs/reference/schema/#the-versions) gives the steps, and the [Better Auth guide](/docs/migrate/better-auth/#the-fill-of-0013-on-a-large-database) gives them for the compat tables.

:::caution
Warning: do not deploy a new core before its migrations run. Every request then answers 500 until they run.
:::

## If it fails

- Every route answers 500, and the log shows `schema_mismatch`: a migration did not run. Apply it.
- On D1 the file of version 16 fails at the execution limits of D1: its fill met too many sessions. The version stays 15. Apply the fill by hand, as the schema page tells.
- `no such table` on D1 at a compat file: its number is lower than the Better Auth table migration. Give it the next number.
- Two copies of `@authtempo/core` in the app: two derive gates, and twice the legacy derives at once. Keep one version.

## Next

- [Schema and migrations](/docs/reference/schema/)
- [Backups](/docs/operations/backups/)
- [Versioning policy](/docs/versioning/)
