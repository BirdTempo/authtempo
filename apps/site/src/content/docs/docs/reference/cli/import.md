---
title: authtempo import
description: Move the users of Supabase, Clerk, Auth0, Firebase, Auth.js, or Cognito into authtempo with one command.
type: reference
sources:
  - packages/cli/README.md "import"
  - packages/cli/README.md "The alias authtempo-import"
  - packages/import/README.md "The exit status and the report"
  - packages/import/README.md "Targets"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17
sidebar:
  order: 4
---

**For:** an operator who moves the users of another system into authtempo.

**What it does:** `authtempo import` reads an export, and writes only the rows that a core flow writes. This page lists its flags and the old flags of `authtempo-import`.

## Before you start

- [Choose a migration path](/docs/migrate/) has the guide of each source.
- No session and no second factor secret moves from any source. Passkeys move only from Auth.js. [The cutover](/docs/migrate/cutover/) tells how people sign in again.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt --target postgres --url-env DATABASE_URL --dry-run
```

To plan an import from Clerk with no database, use the empty store of `--target memory`:

```sh
authtempo import clerk --csv users.csv --users users.json --formats none --target memory --dry-run
```

| Flag | What it does |
| --- | --- |
| `<provider>` | `supabase`, `clerk`, `auth0`, `firebase`, `authjs`, or `cognito`. Exactly one. |
| `--target postgres` | Writes into Postgres. It has no default. |
| `--target d1-bundle` | Writes a bundle for the import Worker on D1 to the file of `--out`, and stops. |
| `--target memory` | Plans against an empty store, with `--dry-run` only. It reads no connection string. |
| `--tables core` | Postgres: core's tables. This is the default. |
| `--tables compat` | Postgres: the Better Auth 1.7 tables of the compatibility package. |
| `--url-env <NAME>`, `--url-file <path>` | The connection string. The default variable is `DATABASE_URL`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--out <file>` | `d1-bundle`: the file of the bundle, with mode 0600. |
| `--users <file>` | The users file of `supabase`, `clerk`, `auth0`, `firebase`, or `cognito`. |
| `--identities <file>` | `supabase`: the identities CSV. |
| `--csv <file>` | `clerk`: the CSV export with the password hashes. |
| `--hashes <file>` | `auth0`: the NDJSON file of the password hashes. |
| `--organizations <file>` | `clerk` and `auth0`: the organizations file. |
| `--authjs-tables <file>` | `authjs`: the JSON file of the `User`, `Account`, and `Authenticator` rows. |
| `--firebase-signer-key-env <NAME>`, `--firebase-signer-key-file <path>` | `supabase`: the Firebase signer key, from a variable or a file. |
| `--firebase-salt-separator <value>` | `supabase`: the Firebase salt separator. Give it with the signer key. |
| `--firebase-rounds <n>` | `firebase`: the rounds of the hash config of the project. |
| `--firebase-mem-cost <n>` | `firebase`: the `mem_cost` of the hash config of the project. |
| `--password-column <name>` | `authjs`: the password column of the `User` table. |
| `--same-passkey-rp-id` | `authjs`: the new app keeps the relying party id, so the passkeys move. |
| `--formats <list>` | Required, except on `cognito`. The `formats` list of the app's `createLegacyPasswordHash`, or `none`. |
| `--legacy-verify` | The app sets `password.legacyVerify`. A `cognito` import needs it. |
| `--on-email-taken skip` | Skips a record whose address is taken. This is the default. |
| `--on-email-taken fail` | Stops the run at the first taken address. |
| `--role-map <list>` | Maps the roles of the source to `owner`, `admin`, or `member`, such as `lead=admin`. |
| `--reserved-slugs <list>` | The `organizations.reservedSlugs` of the app. The defaults of core stay reserved. |
| `--platform-slug <slug>` | The platform organization slug of the app. No import takes it. |
| `--repair` | Writes the missing rows of each `partial` record. |
| `--report <file>` | Also writes the report as JSON, with mode 0600 and no hash. |
| `-n`, `--dry-run` | Prints the report of a real run, and writes nothing. |
| `--json` | Prints `{ report, stopped, bundle }`. The report is the JSON of `--report`. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

## The old flags

| `authtempo-import` | `authtempo import` |
| --- | --- |
| `--postgres <url>` | `--target postgres` with `--url-env <NAME>` or `--url-file <path>` |
| `--better-auth` | `--tables compat` |
| `--d1-bundle <file>` | `--target d1-bundle --out <file>` |
| `--tables <file>` | `--authjs-tables <file>` |
| `--firebase-signer-key <value>` | `--firebase-signer-key-env <NAME>` or `--firebase-signer-key-file <path>` |

`--tables` now names the table set, `core` or `compat`. Every other flag keeps its name and its meaning.

## The alias

- `authtempo-import` stays for one release with its old flags. It prints one deprecation line on stderr.
- With `--postgres`, it prints a second line. A connection string on the command line goes into the shell history.

:::caution
Warning: do not give a format that the app's seam does not verify. The import then writes those hashes, reports no refusal, and exits 0. Each of those users then fails every password sign-in.
:::

:::caution
Warning: the D1 bundle holds every password hash. Do not commit it, and remove it after the Worker run.
:::

## The exit status

| Exit code | What it means |
| --- | --- |
| 0 | Clean: every record imported, or skipped for a reason that the export states. |
| 1 | A person must look: a refused hash, a refused record, a conflict, or a partial record. |
| 2 | A usage error, a malformed input file, or a stop. A stop prints one stopped line. |

A skip that the export states, such as a deleted user, is listed in the report. A stop prints its `stopped:` line on stderr.

## The report

| Key | What it lists |
| --- | --- |
| `created` | The number of users, identities, passwords, passkeys, organizations, and members that the run wrote. |
| `exists` | The number of users and organizations that exist by their import id. A second run writes nothing for them. |
| `skipped` | Each skipped record, with its reason. A conflict and a refused record are skips too. |
| `refusedHashes` | Each refused hash, with its format. The user then imports with no password. |
| `dropped` | Each item that the run left out of a record that it wrote, such as `identity:github`. |
| `partial` | Each record that lacks some of its rows, with the missing row kinds. |
| `repaired` | Each record whose missing rows `--repair` wrote. |

The command prints a summary of the report. `--report <file>` writes the full report as JSON, and `--json` holds it as `report`. `--target d1-bundle` writes no report, because the import Worker makes it.

## The conflicts

The conflicts are `unmatched_row`, `duplicate_row`, `status_compromised`, `status_unknown`, `no_source_id`, `email_taken`, `identity_taken`, `slug_taken`, `no_owner`, `duplicate_passkey`, and `user_not_imported`.

- The import never merges two accounts. A taken address or identity skips the record.
- A second run of the same export writes nothing.
- A repair writes nothing for a user that a claim verified since the import. The record then stays `partial` with `not repaired: verified_since_import`.

## The rules of the rows

- An address is verified only where the export says so.
- A social identity other than Google, Apple, GitHub, or LinkedIn is dropped and listed.
- A GitHub identity imports only as the numeric user id of GitHub.
- A LinkedIn identity imports only as the OpenID Connect `sub`. An id of the older LinkedIn API is dropped and listed as `identity:linkedin_legacy`.
- A hash in a format that `--formats` does not name is refused and listed. The user then imports with no password.

## Next

- [Choose a migration path](/docs/migrate/)
- [The cutover](/docs/migrate/cutover/)
- [The CLI](/docs/reference/cli/)
