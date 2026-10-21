---
title: Choose a migration path
description: Pick the compatibility package or the importer to move an app from another auth system to authtempo.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 2
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 16
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 23
  - docs/superpowers/plans/2026-10-14-11f-migration.md "Task 9"
sidebar:
  order: 1
---

**For:** a developer or an operator who moves an app from another auth system to authtempo.

**What it does:** this page sends you to the guide that fits your source system.

## Before you start

- Know the auth system that the app uses now, and its version. [authtempo import](/docs/reference/cli/import/) lists the sources.
- Know whether the app must keep its code, or may change its auth calls. [Better Auth compatibility](/docs/reference/compat-better-auth/) keeps the code of a Better Auth app.
- Read [The cutover](/docs/migrate/cutover/) once before you choose. Every path ends there.

## Steps

1. Find your source system in the table.
2. Open the guide of that row, and do every step.
3. Do the steps of [The cutover](/docs/migrate/cutover/).

| Source | Path | What moves | What the app changes | The command | Guide |
| --- | --- | --- | --- | --- | --- |
| Better Auth 1.7 | The compatibility package | Everything stays in the app's own tables | Its package aliases, and the options that core refuses | `authtempo migrate --target <postgres, d1, or sqlite> --tables compat --dry-run` | [From Better Auth](/docs/migrate/better-auth/) |
| Supabase Auth | The importer | Users, identities, bcrypt and Argon2id hashes | Its auth calls, to `@authtempo/client` | `authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt,argon2id --target postgres --url-env DATABASE_URL --dry-run` | [From Supabase Auth](/docs/migrate/supabase/) |
| Clerk | The importer | Users, identities, bcrypt hashes, organizations | Its auth calls | `authtempo import clerk --csv export.csv --users users.json --organizations organizations.json --formats bcrypt --target postgres --url-env DATABASE_URL --dry-run` | [From Clerk](/docs/migrate/clerk/) |
| Auth0 | The importer | Users, identities, bcrypt hashes from a support case, organizations | Its auth calls | `authtempo import auth0 --users users.ndjson --hashes hashes.ndjson --organizations organizations.json --role-map lead=admin --formats bcrypt --target postgres --url-env DATABASE_URL --dry-run` | [From Auth0](/docs/migrate/auth0/) |
| Firebase Auth | The importer | Users, identities, Firebase scrypt hashes | Its auth calls | `authtempo import firebase --users users.json --firebase-rounds 8 --firebase-mem-cost 14 --formats firescrypt --target postgres --url-env DATABASE_URL --dry-run` | [From Firebase Auth](/docs/migrate/firebase/) |
| Auth.js | The importer | Users, identities, the app's own password hashes, passkeys | Its auth calls | `authtempo import authjs --authjs-tables tables.json --formats bcrypt --password-column passwordHash --same-passkey-rp-id --target postgres --url-env DATABASE_URL --dry-run` | [From Auth.js](/docs/migrate/authjs/) |
| Amazon Cognito | The importer, and a check against Cognito at the first sign-in | Users, Google and Apple identities | Its auth calls | `authtempo import cognito --users users.json --legacy-verify --target postgres --url-env DATABASE_URL --dry-run` | [From Amazon Cognito](/docs/migrate/cognito/) |
| WorkOS | The importer | Users, Google, Apple, and GitHub identities, organizations, members; no password | Its auth calls | `authtempo import workos --users users.json --identities identities.json --memberships memberships.json --organizations organizations.json --target postgres --url-env DATABASE_URL --dry-run` | [From WorkOS](/docs/migrate/workos/) |

## How it behaves

- The compatibility package runs the app's Better Auth code on the engine. It refuses at start every option that core cannot keep.
- The importer writes only the rows that a core flow writes. An address is verified only where the export says so.
- A second run of the importer on the same export writes nothing.
- No session moves on any path. Every person signs in again once, after the cutover.
- No second factor secret moves. A person with a second factor sets it up again.
- An old password hash verifies at the first right sign-in, and core rewrites it as PBKDF2.
- A person in two sources gives `email_taken` on the import of the second source. The import never merges two accounts.
- After the real run, `authtempo import verify` exits 0 only when the database holds the whole export.

## If it fails

- The compatibility package throws one `BetterAuthCompatError` at start. Its list names every refused option.
- `authtempo import` exits 1 when a person must look at a record, and 2 on a usage error. [The exit status](/docs/reference/cli/import/#the-exit-status) lists each case.

## Next

- [From Better Auth](/docs/migrate/better-auth/)
- [The cutover](/docs/migrate/cutover/)
- [Import CLI](/docs/reference/import-cli/)
