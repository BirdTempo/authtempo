---
title: authtempo import
description: Move the users of Supabase, Clerk, Auth0, Firebase, Auth.js, Cognito, or WorkOS into authtempo with one command.
type: reference
sources:
  - packages/cli/README.md "import"
  - packages/cli/README.md "The alias authtempo-import"
  - packages/import/README.md "The exit status and the report"
  - packages/import/README.md "Targets"
sidebar:
  order: 4
---

**For:** an operator who moves the users of another system into authtempo.

**What it does:** `authtempo import` reads an export of Supabase, Clerk, Auth0, Firebase, Auth.js, Cognito, or WorkOS. It writes only the rows that a core flow writes. This page lists its flags and the old flags of `authtempo-import`.

## Before you start

- [Choose a migration path](/docs/migrate/) has the guide of each source.
- No session and no second factor secret moves from any source. Passkeys move only from Auth.js. [The cutover](/docs/migrate/cutover/) tells how people sign in again.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt --target postgres --url-env DATABASE_URL --dry-run
```

After the real run, `authtempo import verify` checks that the database holds the whole export. [Verify](#verify) gives its rule.

```sh
authtempo import verify supabase --users users.csv --identities identities.csv --formats bcrypt --target postgres --url-env DATABASE_URL
```

To plan an import from Clerk with no database, use the empty store of `--target memory`:

```sh
authtempo import clerk --csv users.csv --users users.json --formats none --target memory --dry-run
```

To print the report of a WorkOS import and write nothing, give the four files of the guide's script:

```sh
authtempo import workos --users users.json --identities identities.json --memberships memberships.json --organizations organizations.json --target postgres --dry-run
```

| Flag | What it does |
| --- | --- |
| `<provider>` | `supabase`, `clerk`, `auth0`, `firebase`, `authjs`, `cognito`, or `workos`. Exactly one. |
| `--target postgres` | Writes into Postgres. It has no default. |
| `--target d1-bundle` | Writes a bundle for the import Worker on D1 to the file of `--out`, and stops. |
| `--target memory` | Plans against an empty store, with `--dry-run` only. It reads no connection string. |
| `--tables core` | Postgres: core's tables. This is the default. |
| `--tables compat` | Postgres: the Better Auth 1.7 tables of the compatibility package. |
| `--url-env <NAME>`, `--url-file <path>` | The connection string. The default variable is `DATABASE_URL`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--out <file>` | `d1-bundle`: the file of the bundle, with mode 0600. |
| `--users <file>` | The users file of `supabase`, `clerk`, `auth0`, `firebase`, `cognito`, or `workos`. |
| `--identities <file>` | `supabase`: the identities CSV. `workos`: the JSON object of the identities of each user. |
| `--csv <file>` | `clerk`: the CSV export with the password hashes. |
| `--hashes <file>` | `auth0`: the NDJSON file of the password hashes. |
| `--organizations <file>` | `clerk`, `auth0`, and `workos`: the organizations file. |
| `--memberships <file>` | `workos`: the JSON array of the organization memberships. Give it with `--organizations`. |
| `--authjs-tables <file>` | `authjs`: the JSON file of the `User`, `Account`, and `Authenticator` rows. |
| `--firebase-signer-key-env <NAME>`, `--firebase-signer-key-file <path>` | `supabase`: the Firebase signer key, from a variable or a file. |
| `--firebase-salt-separator <value>` | `supabase`: the Firebase salt separator. Give it with the signer key. |
| `--firebase-rounds <n>` | `firebase`: the rounds of the hash config of the project. |
| `--firebase-mem-cost <n>` | `firebase`: the `mem_cost` of the hash config of the project. |
| `--password-column <name>` | `authjs`: the password column of the `User` table. |
| `--same-passkey-rp-id` | `authjs`: the new app keeps the relying party id, so the passkeys move. |
| `--formats <list>` | Required, except on `cognito` and `workos`. The `formats` list of the app's `createLegacyPasswordHash`, or `none`. |
| `--legacy-verify` | The app sets `password.legacyVerify`. A `cognito` import needs it. |
| `--on-email-taken skip` | Skips a record whose address is taken. This is the default. |
| `--on-email-taken fail` | Stops the run at the first taken address. |
| `--role-map <list>` | Maps the roles of the source to `owner`, `admin`, or `member`, such as `lead=admin`. |
| `--reserved-slugs <list>` | The `organizations.reservedSlugs` of the app. The defaults of core stay reserved. |
| `--platform-slug <slug>` | The platform organization slug of the app. No import takes it. |
| `--repair` | Writes the missing rows of each `partial` record. |
| `--report <file>` | Also writes the report as JSON, with mode 0600 and no hash. |
| `-n`, `--dry-run` | Prints the report of a real run, and writes nothing. |
| `--json` | Prints `{ report, stopped, bundle, verify, exit }`. The report is the JSON of `--report`. `verify`: the result of `import verify`, or null. `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
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
| 0 | Clean: every record imported, or skipped for a reason that the export states. verify: the database holds the export. |
| 1 | A person must look: a refused hash, a refused record, a conflict, or a partial record. verify: the database does not hold the export. |
| 2 | A usage error, a malformed input file, or a stop. A stop prints one stopped line. |

A skip that the export states, such as a deleted user, is listed in the report. A stop prints its `stopped:` line on stderr.

## Verify

```sh
authtempo import verify <provider> [the files of the provider] --formats <list> --target <postgres|d1-bundle>
```

`import verify` runs the dry run of the export against the database, and reads only. It takes the flags of `import`, and refuses `--repair`, `--dry-run`, `--on-email-taken`, and `--target memory`. The verify reads that each row of a record exists, not its text. It exits 0 only when the database holds the whole export:

- The dry run would write no record.
- No record is `partial`.
- No hash is refused, and no record is a conflict or a refusal.
- A skip that the export states, such as a deleted user, does not count.

It prints one of two lines. The counts are the only numbers, and no line names a record.

```text
verify: the database holds this export: user 812, organization 3
verify: the database does not hold this export: 2 records would be written, 1 partial, 0 need a person
```

Run it after each real run. Before the cutover, run it on the copy of the database. At step 10 of [The cutover](/docs/migrate/cutover/), run it on the real database. The verify does not see a change in the old system that a second import did not carry, and [One real import](/docs/migrate/cutover/#one-real-import) tells why. On D1, write a verify bundle with `--target d1-bundle --out <file>`, and run the Worker again. `--json` holds the result as `verify`.

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
- The import holds the claim of each unverified user while it writes the rows of that user. A claim of the address in that time waits for the import's commit, or answers 409 `conflict` on D1. A claim after the import works. When a claim verified the user before the import checks it after its writes, the import deletes those rows.
- A first run can list a new unverified user as `partial` with `not repaired: claimed`. A claim of the address held the user or verified it during the import, so the import kept no credential. The owner of the address now holds the account, and the record stays `partial`. A second run writes nothing for it, with or without `--repair`. After a claim that threw before its flip, the user stays unverified, and a run with `--repair` writes the rows. When that run still reports `not repaired: claimed`, a lease stays on D1. A claim at the D1 query cap leaves one, and so does an import run that stopped. The app's scheduled sweep deletes the lease at its first run 60 seconds or more after its write. A run after that works. [Delete expired rows (the sweep)](/docs/guides/sweep/) tells how to schedule the sweep.

Each conflict below has its remedy. The reason in the report is the anchor of its section.

### `unmatched_row`

Two export files of one provider disagree on this id, such as the Clerk CSV and the API users. For Clerk, export both files again at the same time. For Auth0, request the hash file again from the support case, or export the users file again to match it.

### `duplicate_row`

One export file holds the same user id twice, so no copy imports. Keep the right copy in the file, and run the import again.

### `status_compromised`

Cognito marks the user as compromised. Reset the user in Cognito, then export the users and run the import again.

### `status_unknown`

Cognito gives the user no status, or a status that the importer does not know. The report lists the value as `status:<value>`. Check the user in the Cognito console.

### `no_source_id`

The record has no provider id, so it has no import key. Find the record in the source system, and export it again with its id.

### `email_taken`

Another user holds the address. A person in two sources gives this on the second import, because the import never merges two accounts. Ask the person which account to keep.

### `identity_taken`

Another user holds the social identity, and the import never merges two accounts. Ask the person which account to keep.

### `slug_taken`

Another organization holds the slug. Change the slug of one of the two organizations, and run the import again.

### `no_owner`

No member of the organization maps to an owner. Map a source role to `owner` or `admin` with `--role-map`, or make a member an admin in the source.

### `duplicate_passkey`

One record holds a passkey credential id twice, or another write took it. Core keeps one row per credential. If the record holds the id twice, remove one row from the export. Else run the import again.

### `user_not_imported`

A member of an organization names a user that did not import. Read the skip of that user, fix its cause, and run the import again.

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
