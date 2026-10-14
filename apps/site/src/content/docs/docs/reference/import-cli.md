---
title: Import CLI
description: The command, the options, the targets, the exit status, and the report of authtempo-import.
type: reference
sources:
  - packages/import/README.md "The exit status and the report"
  - packages/import/README.md "Targets"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17
---

**For:** an operator who moves the users of another system into authtempo.

**What it does:** `authtempo-import` reads an export of Supabase, Clerk, Auth0, Firebase, Auth.js, or Cognito, and writes only the rows that a core flow writes.

## Before you start

- Read [Choose a migration path](/docs/migrate/) for the guide of each source.
- No session and no second factor secret moves from any source. Passkeys move only from Auth.js.

## The command

```sh
authtempo-import <provider> --users <file> --formats <the seam's list> --postgres "$DATABASE_URL" --dry-run
```

| Option | What it does |
| --- | --- |
| `<provider>` | `supabase`, `clerk`, `auth0`, `firebase`, `authjs`, or `cognito`. Name exactly one. |
| The input files | `--users`, `--hashes`, `--organizations`, and the other file options of the source. The guide of each source names them. |
| `--formats` | Required, with no default. The `formats` list of the app's `createLegacyPasswordHash`, joined by commas, or `none`. Only `cognito` may leave it out. |
| `--legacy-verify` | States that the app sets `password.legacyVerify`. `cognito` needs it. |
| `--dry-run` | Prints the report of a real run, and writes nothing. |
| `--postgres <url>` | Writes core's tables on Postgres. |
| `--postgres <url> --better-auth` | Writes the Better Auth 1.7 tables of an app on the compatibility package. |
| `--d1-bundle <file>` | Writes a bundle for the import Worker on D1. Give `--postgres` or `--d1-bundle`, not both. |
| `--on-email-taken fail` | Stops the run at the first taken address. The default skips the record. |
| `--repair` | Writes the missing rows of each `partial` record. |
| `--report <file>` | Also writes the report as JSON, with mode 0600 and no hash. |
| `--reserved-slugs` | The app's `organizations.reservedSlugs`. Core's defaults stay reserved. |
| `--platform-slug` | The app's platform organization slug. No import takes it. |
| `--role-map` | Maps the role names of the source to core's roles, such as `lead=admin`. Auth0 has no default map. |
| `--firebase-rounds`, `--firebase-mem-cost` | The hash parameters of the Firebase project. |

`authtempo-import` with no arguments prints the full usage, with the options of each source.

:::caution
Warning: do not give a format that the app's seam does not verify. The import then writes those hashes, reports no refusal, and exits 0. Each of those users then fails every password sign-in.
:::

:::caution
Warning: the D1 bundle holds every password hash. Do not commit it, and remove it after the Worker run.
:::

## The exit status

| Status | When |
| --- | --- |
| 0 | Clean. A skip that the export states, such as a deleted or banned user, is listed and does not count. |
| 1 | A person must look: a refused hash, a refused record, a conflict, or a `partial` record. |
| 2 | A usage error, a malformed input file, or a stop. A stop prints one `stopped:` line. |

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
- [Schema and migrations](/docs/reference/schema/)
