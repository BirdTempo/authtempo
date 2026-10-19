---
title: authtempo check
description: Check that a deployment answers as core promises, with one anchor and one fix for each code.
type: reference
sources:
  - packages/cli/README.md "check"
  - packages/core/src/http/routes/sessions.ts
  - packages/core/src/http/cookies.ts
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 8"
  - docs/superpowers/plans/2026-10-14-11c2-cli-additions.md "Task 7"
  - docs/superpowers/plans/2026-10-14-12e-oauth-provider-v2.md "Task 2"
sidebar:
  order: 5
---

**For:** an operator who checks a deployment after a deploy, or a developer who reads a code of `authtempo check`.

**What it does:** this page lists each check of `authtempo check`, and each code that it reports, with its fix.

## Before you start

- A deployment that answers on its base URL. [Deploy](/docs/operations/deploy/) tells how. The command reads public documents only, and sends no credential.
- [The CLI](/docs/reference/cli/) lists the exit codes and the output.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo check https://api.example.com
authtempo check https://api.example.com --target postgres --url-env DATABASE_URL --strict
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--strict` | Counts each skipped check as a failure, except `compat_database`. |
| `--target postgres`, `--target d1` | Read the schema version and the table shape from this kind of database. Without it, the two schema checks skip. |
| `--url-env <NAME>`, `--url-file <path>` | Postgres: the connection string. The default variable is `DATABASE_URL`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--database <name>`, `--config <path>`, `--remote` | D1: the database of the wrangler config, as for `authtempo migrate`. |
| `--json` | Prints `{ base, checks, warnings, summary, exit, stopped }`. `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | No check failed. A warning or a skip is no failure. |
| 1 | A check failed. A person must look. |
| 2 | A usage error, a host or a database that gives no answer, or a schema version that this CLI cannot read. |

The command runs eight checks. Each check reports `pass`, `fail` with a code, or `skip` with a reason. A skip never counts as a pass. The last line counts the checks, such as `checks: 8 run, 6 pass, 0 fail, 2 skip`.

The first read of the key set on a new database writes its first signing key. That is the first-use rule of core.

## https

<h3 id="base_not_https"><code>base_not_https</code></h3>

The base URL uses `http` on a host that is not this machine. A browser drops the `Secure` session cookie there. Serve the API on `https`.

## mount

<h3 id="mount_missing"><code>mount_missing</code></h3>

`GET <basePath>/session` answers 404, or an answer that is not JSON. The routes are not at the base path. Mount `auth.handle` under `basePath`, or give `--base-path`.

<h3 id="mount_wrong_answer"><code>mount_wrong_answer</code></h3>

`GET <basePath>/session` with no credential answers JSON, but not 401 `unauthorized`. Another handler answers before `auth.handle`.

<h3 id="no_mount"><code>no_mount</code></h3>

A skip of `origin_rule`, `cookie`, and `jwks`, because these checks need the mount. Fix `mount_missing` or `mount_wrong_answer` first.

## origin_rule

<h3 id="origin_not_enforced"><code>origin_not_enforced</code></h3>

A POST with the `Origin` `https://check.invalid` answers another status than 403. A proxy drops the `Origin` header, or the app answers before `auth.handle`. Pass the header through.

## cookie

<h3 id="cookie_missing"><code>cookie_missing</code></h3>

`POST <basePath>/sign-out` answers no `Set-Cookie`. A proxy drops the header, or another handler serves the route.

<h3 id="cookie_not_httponly"><code>cookie_not_httponly</code></h3>

The session cookie has no `HttpOnly`, so a script of the page can read it. A proxy changes the cookie of core. Keep the header as core sends it.

<h3 id="cookie_not_secure"><code>cookie_not_secure</code></h3>

The session cookie has no `Secure`, so a browser sends it over `http`. A proxy changes the cookie of core. Keep the header as core sends it.

<h3 id="cookie_path_not_root"><code>cookie_path_not_root</code></h3>

The session cookie has no `Path=/`, so the browser sends it on some paths only. Keep the header as core sends it.

<h3 id="cookie_no_samesite"><code>cookie_no_samesite</code></h3>

The session cookie has no `SameSite` of `Lax`, `Strict`, or `None`, so the browser applies its own default. A proxy changes the cookie of core. Keep the header as core sends it.

<h3 id="cookie_samesite_none"><code>cookie_samesite_none</code></h3>

A warning, not a failure. The cookie is `SameSite=None`, from `cookie: { sameSite: "None" }` in the config. Keep it only for an app on another site.

## jwks

<h3 id="jwt_mint_off"><code>jwt_mint_off</code></h3>

A skip: `GET <basePath>/jwks` answers 404, because the config sets `jwtMint: false`.

<h3 id="jwks_bad_answer"><code>jwks_bad_answer</code></h3>

The key set answers another status than 200, or no JSON with `keys`. The log of the API names the error.

<h3 id="jwks_empty"><code>jwks_empty</code></h3>

The key set holds no key. Core always lists its signing key, so another handler answers this path.

<h3 id="jwks_private_part"><code>jwks_private_part</code></h3>

Warning: a key of the key set holds `d`, a private part. Rotate the key at once with `authtempo keys rotate`, and remove the handler that serves it.

<h3 id="jwks_bad_key"><code>jwks_bad_key</code></h3>

A key is not a public signing key of `EdDSA`, `ES256`, or `RS256`. It has no `kid`, or a `use` other than `sig`. Or its members do not fit its `alg`, it holds a private member, or its RSA modulus is under 2048 bits. Another handler answers this path.

<h3 id="jwks_no_cache_control"><code>jwks_no_cache_control</code></h3>

The key set has no `cache-control` header. Core sends `public, max-age=300`, so a proxy drops the header.

<h3 id="jwks_cache_not_public"><code>jwks_cache_not_public</code></h3>

The `cache-control` of the key set is not `public` with a `max-age` above 0, or it holds `no-store`. Each verifier then fetches the keys for each token. Core sends `public, max-age=300`, so a proxy changes the header.

## well_known

<h3 id="oauth_off"><code>oauth_off</code></h3>

A skip: both documents answer 404, because the config has no `oauth`.

<h3 id="well_known_bad_answer"><code>well_known_bad_answer</code></h3>

One document answers and the other does not, or an answer is not JSON. Mount `auth.wellKnown` for each path under `/.well-known/`.

<h3 id="well_known_mismatch"><code>well_known_mismatch</code></h3>

The two documents name another `issuer` or another `jwks_uri`. A proxy or a cache serves an old copy of one of them.

<h3 id="well_known_issuer"><code>well_known_issuer</code></h3>

The `issuer` is not the base URL plus `basePath`. Set `baseURL` in the config to the origin that the check reads.

<h3 id="well_known_jwks_uri"><code>well_known_jwks_uri</code></h3>

The `jwks_uri` is not `<basePath>/jwks` on the base URL. Another handler serves the documents.

<h3 id="well_known_not_at_root"><code>well_known_not_at_root</code></h3>

The documents answer under `basePath` only. RFC 8414 puts them at the origin root, so mount `auth.wellKnown` there.

## schema_version

<h3 id="no_database"><code>no_database</code></h3>

A skip: the command has no database. Give `--target` and the inputs of the database.

<h3 id="schema_missing"><code>schema_missing</code></h3>

The database has no `ta_meta`. Run `authtempo migrate`.

<h3 id="schema_behind"><code>schema_behind</code></h3>

The database is at an older version than the core of the CLI. Run `authtempo migrate` before the deploy.

<h3 id="schema_ahead"><code>schema_ahead</code></h3>

The database is at a newer version than the core of the CLI. Use a newer CLI.

## schema_shape

The check compares each `ta_` table of the database with the tables that the migrations of the adapter make. It compares the columns, their types, the NOT NULL rules, the primary key, and the indexes. The order of the columns is no finding, and an extra index is no finding. A warning is a line that starts with its code. A name that is not a plain SQL name prints as "a name that is not a plain SQL name". The skip `no_database` is the one of `schema_version`.

<h3 id="schema_not_current"><code>schema_not_current</code></h3>

A skip: the `schema_version` check did not pass, so the tables are not the tables of this CLI. Run `authtempo migrate`, then check again.

<h3 id="compat_database"><code>compat_database</code></h3>

A skip: the database holds the Better Auth compatibility tables, which have another shape, and the check compares core's own tables only. `--strict` keeps this skip as a skip, because no fix applies to a supported compat database.

<h3 id="schema_table_missing"><code>schema_table_missing</code></h3>

A table of the migrations is missing, so core fails on each operation that uses it. Run `authtempo migrate`, or restore the table from a backup.

<h3 id="schema_column_missing"><code>schema_column_missing</code></h3>

A column of the migrations is missing, so core fails on each read or write of the table. Add the column again as the migration makes it.

<h3 id="schema_column_type"><code>schema_column_type</code></h3>

A column has another type than the migration makes, so core can read wrong values from it. Change the column back to the type of the migration.

<h3 id="schema_column_null"><code>schema_column_null</code></h3>

A column has another NOT NULL rule than the migration makes, and a NOT NULL column where core writes null fails each insert. Change the rule back to the rule of the migration.

<h3 id="schema_unique_missing"><code>schema_unique_missing</code></h3>

A unique index or the primary key is missing or has another column order, and the claim rule needs the unique email. Core maps a unique conflict to its fields by the index name, so make the index again as the migration makes it.

<h3 id="schema_index_missing"><code>schema_index_missing</code></h3>

A warning: a plain index of the migrations is missing or has another column order, so core reads a large table slowly. Make the index again.

<h3 id="schema_column_extra"><code>schema_column_extra</code></h3>

A warning: the table has a column that the migrations do not make, and core does not read or write it. Keep it only when your app needs it.

<h3 id="schema_column_extra_required"><code>schema_column_extra_required</code></h3>

A warning: the table has an extra NOT NULL column with no default, so each insert of core into the table fails. Give the column a default, or make it nullable.

<h3 id="schema_table_extra"><code>schema_table_extra</code></h3>

A warning: the database has a `ta_` table that the migrations do not make, and the `ta_` prefix is for core's tables. Give the table of your app another name.

## Next

- [Deploy](/docs/operations/deploy/)
- [Routes](/docs/reference/routes/)
- [Cookies](/docs/reference/cookies/)
