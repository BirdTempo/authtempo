---
title: authtempo info
description: Print a support report of the tools, the project, the database, and the deployment, with no secret value and no host name.
type: reference
sources:
  - packages/cli/src/commands/info.ts
  - packages/cli/src/help/info.ts
  - docs/superpowers/plans/2026-10-14-11c2-cli-additions.md "Task 5"
sidebar:
  order: 11
---

**For:** a person who opens an issue, or an operator who answers one. The report gives the versions and the shape of a setup in one paste.

**What it does:** this page lists the four parts of the report of `authtempo info`, its flags, its JSON document, and what the report never holds.

## Before you start

- The database part takes the inputs of `authtempo check`: a connection string or a wrangler config. [authtempo check](/docs/reference/cli/check/) lists them.
- The deployment part needs the operator routes on, with `operator: { secretHash }` in the config. [Configuration](/docs/reference/config/) lists the key.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo info
authtempo info --target postgres
authtempo info https://api.example.com
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. It is optional. With it, the report has a deployment part. |
| `--target postgres`, `--target d1` | Reads this kind of database. Without it, the report has no database part. |
| `--url-env <NAME>` | Postgres: the variable of the connection string. The default is `DATABASE_URL`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--url-file <path>` | Postgres: the file of the connection string. A dash reads stdin. |
| `--database <name>` | D1: the `database_name` in the wrangler config. |
| `--config <path>` | D1: the wrangler config of the project. The default is `wrangler.jsonc`. |
| `--remote` | D1: reads the database on Cloudflare. The default is the local database. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of the request, from 1 to 120. The default is 10. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | Each part that a flag asked for answered. |
| 1 | A part that a flag asked for gave no answer. The report names the part and the reason. |
| 2 | A usage error, or a stop before the report. |

The command judges no value. [authtempo check](/docs/reference/cli/check/) judges.

## The four parts

1. **The tools.** The CLI version, its schema version, the Node version with the platform and the architecture, and the package manager. The package manager comes from `npm_config_user_agent`, else from the `packageManager` field of the nearest `package.json`. The tools part runs no child process.
2. **The project.** The nearest `package.json` upward from the folder. Each `@authtempo` package that it names, with the installed version or `not installed`, and the adapters among them. With a `wrangler.jsonc` or `wrangler.json` beside it, the `database_name` of each D1 binding.
3. **The database.** With `--target`: the kind, the schema version, the count of applied migrations, and the compat version. The compat version is read on Postgres only. The command reads the database through the inputs of `authtempo check`.
4. **The deployment.** With a base URL: the version of core, its schema version, and the key paths of its config. A key path is a name such as `operator.secretHash`. The command calls `GET /operator/info` with the operator secret. The route answers key names, never a value.

The environment line lists each secret name of the templates as `set` or `unset`: `AUTH_SECRET`, `DATABASE_URL`, and `AUTHTEMPO_OPERATOR_SECRET`. Each set value joins the scrub list before the first line prints, so no line can hold it.

The report prints one line per part:

```text
authtempo 0.0.0 (schema version 12)
runtime: node v26.10.0, linux, x64
package manager: pnpm 12.8.1 (from npm_config_user_agent)
packages: @authtempo/adapter-d1 0.0.0, @authtempo/core 0.0.0
adapters: adapter-d1
wrangler: 1 D1 database: auth
env: AUTHTEMPO_OPERATOR_SECRET set, AUTH_SECRET set, DATABASE_URL unset
database: d1, schema version 12, 12 migrations applied, compat version none
deployment: core 0.0.0, schema version 12, 9 config keys, 0 dropped
config key: baseURL
config key: operator.secretHash
```

A part that a flag asked for and that gave no answer prints as `unread: <part>: <reason>`, and the command exits 1. The reason of a database is the code of the driver error, such as `storage: 28P01`, with no host. The reason of a deployment is the HTTP status with a short cause, such as `GET /operator/info answered 404: the operator route is off, or core is older than 11c2`.

A deployment answers untrusted text. A `core` that is no version prints as `unreadable`. A key path that is not a plain name, or a dotted pair of plain names, is dropped and counted. After 400 key paths, the rest are dropped too. An answer above 64 KiB, or with a `schemaVersion` that is no whole number from 1 to 9999, is unread.

## The JSON

| Key | What it holds |
| --- | --- |
| `cli` | The version of the CLI. |
| `schemaVersion` | The schema version of the core that the CLI bundles. |
| `runtime` | `node`, `platform`, and `arch` of the process. |
| `packageManager` | `name`, `version`, and `source` (`user-agent` or `package.json`), or null. |
| `packages` | Each `@authtempo` package of the nearest `package.json`, with its installed version or null. |
| `adapters` | The adapter packages among them: `adapter-d1`, `adapter-postgres`, `compat-better-auth`. |
| `project` | `wrangler` (true when a wrangler config exists) and `d1Databases` (each `database_name`), or null with no `package.json`. |
| `env` | Each secret name of the templates, `set` or `unset`. |
| `database` | `kind`, `schemaVersion`, `applied`, and `compatVersion`, or null without `--target`. |
| `deployment` | `core`, `schemaVersion`, `configKeys`, and `dropped`, or null without a base URL. |
| `unread` | One entry per part that gave no answer: `part` (`database` or `deployment`) and `reason`. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop or a usage error holds the empty values of each key, `exit: 2`, and the reason in `stopped`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## What the report never holds

- No value of a variable. The environment line says `set` or `unset`.
- No host, port, or database name of a connection string. A database failure prints its code only.
- No `database_id` of a wrangler config. The report lists the `database_name` of each binding only.
- No config value. The deployment part lists key paths, and the route answers no value.
- No text of the deployment that is not a plain name or a version. Any other text is dropped or reads as `unreadable`.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/info`](/docs/reference/routes/#get-operator-info) |
| Header | `Authorization: Operator <secret>` |
| Answer | `{ core, schemaVersion, configKeys }`. The key paths of the config, never a value. |
| Limit | The key `operator-secrets:ip:<ip>`, a window of 1 hour, and 120 calls, right or wrong secret, shared with `secret status` and `secret rewrap`. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

A deployment with no `operator` in its config answers 404. The deployment part is then unread, and the command exits 1.

## Next

- [authtempo check](/docs/reference/cli/check/)
- [Secrets](/docs/operations/secrets/)
- [The CLI](/docs/reference/cli/)
