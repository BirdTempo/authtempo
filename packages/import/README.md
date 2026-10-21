# @authtempo/import

Moves users, social identities (Google, Apple, GitHub, and LinkedIn), password hashes, Auth.js
passkeys, organizations, and members into authtempo (spec 17). No session
moves from any source, and no MFA secret moves (spec 17.5). Passkeys move only
from Auth.js. A Clerk, Supabase, Auth0, Firebase, Cognito, or WorkOS passkey
needs a new enrolment.

```bash
authtempo import <provider> [files] --formats <the seam's list> --target postgres --url-env DATABASE_URL --dry-run
```

The command is `authtempo import` in `@authtempo/cli` (plan 11c). The old binary `authtempo-import` stays for one release as an alias with its old flags, and prints one deprecation line. The connection string comes from the variable that `--url-env` names (default `DATABASE_URL`) or from `--url-file`, never from a flag value.

Run `--dry-run` first. It prints the report a real run prints. The importer
writes only rows that a core flow writes: an address is verified only where
the export says so, and a social identity other than Google, Apple, GitHub, or
LinkedIn is dropped and listed.

A GitHub identity imports only as GitHub's numeric user id; any other subject
is dropped and listed as `identity:github:subject_form`. A LinkedIn identity
imports only when the export marks it as LinkedIn's OpenID Connect `sub`:
Supabase `linkedin_oidc`, Clerk `oauth_linkedin_oidc`, or an Auth.js account
of type `oidc`. An id of the older LinkedIn API (Supabase `linkedin`, Clerk
`oauth_linkedin`, an Auth.js account of type `oauth`, and every Auth0
`linkedin` identity) is dropped and listed as `identity:linkedin_legacy`.
LinkedIn's `sub` is pairwise per client id, so an imported LinkedIn identity
links only while the app keeps the LinkedIn client id that the old system
used. Firebase and Cognito have no built-in LinkedIn provider.

A social subject longer than 255 characters is dropped and listed as
`identity:<provider>:subject_length`. Core's social sign-in never answers
such a subject, and the MySQL column holds 255 characters.

An Auth.js passkey whose credential id is longer than 1023 bytes is dropped
and listed as `passkey:credential_id_length`. WebAuthn allows no longer id,
core's registration refuses one, and the MySQL column holds 1023 bytes.

`--formats` is required, and it has no default. Give it the `formats` list
of the app's `createLegacyPasswordHash`, comma-separated, or `none` for an app
with no legacy seam. A hash in another format is refused and listed. The user
is then imported with no password, and a reset or a magic link signs that user
in. Only `cognito` and `workos` may leave out `--formats`, because neither
exports a hash.

WARNING: Do not give a format that the app's seam does not verify. The import
then writes those hashes, reports no refusal, and exits 0. Each of those users
then fails every password sign-in.

## The exit status and the report

| Status | When |
| --- | --- |
| 0 | Clean. A skip that the export states is listed and does not count. These skips are anonymous, deleted, disabled, banned, a Supabase SSO user, and four Cognito statuses: unconfirmed, force change password, reset required, and archived. |
| 1 | A person must look: a refused hash, a refused record (`invalid_` or `reserved_` reasons), a conflict, or a `partial` record. The Cognito conflicts are `status_compromised`, `status_unknown`, and `no_source_id`. |
| 2 | A usage error, a malformed input file, or a stop. A stop prints one `stopped:` line. A stop before the first write says "nothing was written". A stop during the run (a storage error, or `--on-email-taken fail`) keeps the records before it, and a re-run counts them as `exists`. |

The conflicts are `unmatched_row`, `duplicate_row`, `status_compromised`,
`status_unknown`, `no_source_id`, `email_taken`, `identity_taken`,
`slug_taken`, `no_owner`, `duplicate_passkey`, and `user_not_imported`
(`CONFLICT_REASONS` in `src/types.ts`). The import never merges two accounts:
a taken address or identity skips the record, or with `--on-email-taken fail`
stops the run.

The summary prints one line of the hash formats of the export, for example
`hashes: bcrypt 812, argon2id 4, none 31`. Check it against `--formats`
before the real run.

Run the import again at any time: a second run of the same export writes
nothing, and a user that exists by its import id is never written again
without `--repair`. Some re-runs can list a user as `partial`, with the
missing row kinds, and the CLI then exits 1. These are a re-run after a
claim, after another change in the app, with a newer export, or with other
options. Check each such user in the app before any repair. Then run the
import again with `--repair`: each `partial` record gets exactly the rows
that `missing` names, and the report lists them as `repaired`. A repair
writes nothing, and the record stays `partial` with `not repaired:
<reason>`, when a core flow can have removed the rows on purpose:
`verified_since_import` (a claim verified the user and removed the
claimant's credentials), `email_changed` (the user's address changed in the
app), `credential_exists` (an unverified user that holds another credential
now), `identity_taken` (another user holds the identity), `claimed` (a
verified user that holds its `email` identity lacks a password, a passkey,
or a social identity), or `no_owner` (an organization whose members map to
no owner). A verified user's missing credential is an operator action,
because the importer cannot tell a claim from a newer export. Each user
repair checks the user row again after its writes: when a claim or an
address change lands during the repair, the repair deletes the rows it
wrote, and the record stays `partial` with `not repaired: claimed`. The
repaired password row is pending until the repair's last statement
activates it, after that check, so a sign-in with it fails until then. A repaired passkey or social
identity is active at once: on D1, for a few round trips before the check,
it can sign in a claimant who also holds the authenticator or the provider
login. Without
`--repair` the importer writes nothing for a `partial` record.

A repair also gives back a credential that the user removed in the app
since the first run, for example a password or a passkey. The importer
cannot tell that removal from a stopped run, so check in the app that each
user still wants each missing credential before you run `--repair`. The
`email_changed` guard looks only at an `email` identity. An unverified user
whose address changed can still get another missing credential back, but no
path reaches that state today: core has no address change flow, and an
unverified user with no credential has no session to change the address
with.

`--report <file>` also writes the report as JSON. The report file holds no
hash. It is written with mode 0600.

## Verify

```bash
authtempo import verify supabase --users users.csv --identities identities.csv --formats bcrypt,argon2id --target postgres --url-env DATABASE_URL
```

`authtempo import verify` runs the dry run of the export against the
database, and reads only (spec 23 item 7). It exits 0 only when the database
holds the whole export: the dry run would write no record, no record is
`partial`, no hash is refused, and no record is a conflict or a refusal. A
skip that the export states does not count. The verify reads that each row
of a record exists, not its text. It prints one of two lines, with counts
and no record:

```text
verify: the database holds this export: user 812, organization 3
verify: the database does not hold this export: 2 records would be written, 1 partial, 0 need a person
```

It refuses `--repair`, `--dry-run`, `--on-email-taken`, and `--target
memory`. Run it after each real run: on a copy of the database before
the cutover, and on the real database at the cutover. It reads that each
row exists, not its text, so it does not see a change in the old system
that a second import did not carry. On D1, write a
verify bundle with `--target d1-bundle --out <file>` and run the Worker
again (`worker/README.md`). `verifyReport` of this package is the one rule,
and the D1 Worker reads it too.

## The exports

Checked against each provider's docs on 2026-10-11. Check a real export
against the owner runbook in the plan index before you run it for real. A
fact below marked unverified is one item of that runbook.

### Supabase

Two CSV files from the database; the Admin API returns no hash:

```bash
psql "$SUPABASE_DB_URL" -c "\copy (select id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, is_anonymous, deleted_at, banned_until, is_sso_user from auth.users) to 'users.csv' with csv header"
psql "$SUPABASE_DB_URL" -c "\copy (select provider, provider_id, user_id from auth.identities) to 'identities.csv' with csv header"
authtempo import supabase --users users.csv --identities identities.csv --formats bcrypt,argon2id --target postgres --url-env DATABASE_URL
```

- Every column of the two selects must be in the header. A missing column
  stops the run before any read, because an empty `banned_until` or
  `is_sso_user` would import a banned or SSO user.
- SSO (SAML) users are not imported. authtempo has no SAML mapping. Each one
  is listed as `sso_user`, and the CLI exits 0 on them.
- A `banned_until` that is not a time in the past skips the user as `banned`,
  also a value the reader cannot read, such as `infinity`.
- A phone-only user has no email and is skipped as `no_email`. Supabase
  passkeys do not move (spec 17.5).
- The `github` provider imports as GitHub. The `linkedin_oidc` provider
  imports as LinkedIn. The older `linkedin` provider is listed as
  `identity:linkedin_legacy`.
- Rows with Supabase's `$fbscrypt$` tag need `--firebase-signer-key-env` (or `-file`) and
  `--firebase-salt-separator`, the same values as the seam's `firebase`
  option, and `firescrypt` in `--formats`. A row of another Firebase project
  is refused and listed.
- Unverified: the base64 alphabet of Supabase's Argon2 rows, and `$fbscrypt$`
  rows with no `sk` (runbook item 2).

### Clerk

Two files, joined on the exact user id. The dashboard CSV (Settings, User
exports) has the password digests. `GET /v1/users` has the created date, the
external accounts, and the address flag. Save the script below as
`clerk-export.sh`, and run it with `bash clerk-export.sh`. It fetches every
page and joins them into one array. A pasted `set -e` closes the shell at the
first error. A failed run writes no new file and keeps the old `users.json`.

```bash
set -euo pipefail
umask 077
# Every page goes to a temporary folder first. Only a complete run moves users.json here.
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
o=0; : > "$t/pages.ndjson"
while :; do
  page=$(curl -sSf -H "Authorization: Bearer $CLERK_SECRET_KEY" "https://api.clerk.com/v1/users?limit=500&offset=$o")
  [ "$(printf '%s' "$page" | jq length)" -eq 0 ] && break
  printf '%s\n' "$page" >> "$t/pages.ndjson"
  o=$((o + 500))
done
jq -s 'add // []' "$t/pages.ndjson" > "$t/users.json"
mv "$t/users.json" .
```

```bash
authtempo import clerk --csv export.csv --users users.json [--organizations organizations.json] --formats bcrypt --target postgres --url-env DATABASE_URL
```

- `organizations.json` is an array of `GET /v1/organizations` objects, each
  with a `memberships` array from `GET /v1/organizations/{id}/memberships`.
  `org:admin` becomes `owner`. A file that is not a JSON array stops the run.
- A user in one file and not in the other is listed as `unmatched_row`. An id
  that one file holds twice is listed as `duplicate_row`, and no copy imports.
- Only a `password_hasher` of `bcrypt` imports. Any other value is refused by
  its name. A CSV row with no digest for a user whose `password_enabled` is
  true is refused as `missing`. A `banned` value other than `false` skips the
  user.
- A user or a CSV row with no id is listed as `no_source_id`, a conflict. So
  is an organization with no id.
- The `oauth_github` strategy imports as GitHub. The `oauth_linkedin_oidc`
  strategy imports as LinkedIn. The older `oauth_linkedin` strategy is listed
  as `identity:linkedin_legacy`.
- Unverified: the unit of `created_at` (a value below 1e11 is read as
  seconds, else milliseconds), the `password_hasher` values of a real export,
  and the `banned` field (runbook item 3).

### Auth0

The user export job (`POST /api/v2/jobs/users-exports`, format `json`) gives
NDJSON. Its file can be gzip-compressed (unverified, runbook item 12).
Decompress it first, for example `gunzip users.ndjson.gz`. The password
hashes come only through a support case, as a PGP-encrypted file. Decrypt
it, then pass it as `--hashes`. Without `--hashes`, the CLI prints one line
and imports no password.

```bash
authtempo import auth0 --users users.ndjson [--hashes hashes.ndjson] [--organizations organizations.json] --role-map lead=admin --formats bcrypt --target postgres --url-env DATABASE_URL
```

`organizations.json` is one JSON array of `GET /api/v2/organizations`
objects. Add a `members` array to each object, with one entry per member:
`{ "user_id": "...", "roles": [{ "id": "...", "name": "..." }] }`. The reader
reads `id`, `display_name`, `name`, and `members`, and only the role `name`.
Save the array itself, not the page object `{ "organizations": [...] }`: any
other top-level value stops the run.

- A hash line is used only when exactly one user matches `auth0|<_id>` (or
  `alt_id`) and the addresses are equal. Else the line is listed as
  `unmatched_row`, or the hash is refused as `hash_email_mismatch`.
- Only a `$2a$` or `$2b$` hash imports. Any other is refused by its format.
- Auth0 roles have no default map. Map your role names with `--role-map`. An
  unmapped role becomes `member`. An organization with no owner gets its
  first admin as owner; with no admin it is skipped as `no_owner`.
- A `blocked` value other than `false` skips the user as `banned`.
- A `github` identity imports as GitHub. Every `linkedin` identity is listed
  as `identity:linkedin_legacy`, because the export does not show whether its
  id is the OpenID Connect `sub` (unverified on 2026-10-12).
- A user line or an organization with no id is listed as `no_source_id`, a
  conflict.
- Unverified: the hash algorithm (`$2b$10$` in every sample), the hash file's
  field list, and whether `user_id` carries `_id` or `alt_id` (runbook item
  4).

### Firebase

`firebase auth:export users.json --format=json`, and from the console
(Authentication, Users, "Password hash parameters") `rounds` and `mem_cost`:

```bash
authtempo import firebase --users users.json --firebase-rounds 8 --firebase-mem-cost 14 --formats firescrypt --target postgres --url-env DATABASE_URL
```

- The signer key and the salt separator go to the seam's `firebase` option,
  not to the CLI.
- `rounds` and `mem_cost` outside the grammar's bounds stop the run before
  any read. Each is 1 to 99, and 2^mem_cost times rounds is at most 2^18.
- The reader cannot detect a hash made with another project's parameters.
  The export carries none to compare. A wrong value refuses every first
  sign-in with no report line. Sign in once with a known user before the
  cut-over.
- A `disabled` value other than `false` skips the user.
- A `github.com` provider imports as GitHub, with its `rawId`. Firebase has no
  built-in LinkedIn provider. A custom `oidc.<name>` provider is dropped and
  listed.
- Unverified: the JSON type of `createdAt` and the `{ "users": [...] }`
  wrapper (runbook item 5).

### Auth.js

One JSON object of the adapter tables (Postgres with Prisma names). The
select takes only the columns the reader uses. `Account` also holds each
user's OAuth tokens, and a refresh token gives access to that user's account
at the provider, so the select leaves them out. Prisma stores
`emailVerified` as a timestamp with no time zone. The reader needs the zone,
so the select adds it. Without the zone, every user imports unverified and
the report lists `email_verified:unreadable`.

WARNING: `tables.json` holds the password hashes. Write it with `umask 077`,
as below, and delete it after the run.

```bash
(umask 077; psql -At "$DATABASE_URL_OLD" -c "select json_build_object('users', (select coalesce(json_agg(json_build_object('id', u.id, 'email', u.email, 'emailVerified', u.\"emailVerified\" at time zone 'UTC', 'name', u.name, 'image', u.image, 'passwordHash', u.\"passwordHash\")), '[]') from \"User\" u), 'accounts', (select coalesce(json_agg(json_build_object('userId', a.\"userId\", 'type', a.type, 'provider', a.provider, 'providerAccountId', a.\"providerAccountId\")), '[]') from \"Account\" a), 'authenticators', (select coalesce(json_agg(json_build_object('credentialID', x.\"credentialID\", 'userId', x.\"userId\", 'credentialPublicKey', x.\"credentialPublicKey\", 'counter', x.counter, 'credentialDeviceType', x.\"credentialDeviceType\", 'credentialBackedUp', x.\"credentialBackedUp\", 'transports', x.transports)), '[]') from \"Authenticator\" x))" > tables.json)
authtempo import authjs --authjs-tables tables.json --formats bcrypt [--password-column passwordHash] [--same-passkey-rp-id] --target postgres --url-env DATABASE_URL
rm tables.json
```

- `passwordHash` is an example name. Put the app's own password column in
  the select and in `--password-column`, or remove that pair from the select
  when the app has no password column.
- When the `emailVerified` column is already `timestamptz`, write
  `u."emailVerified"` with no `at time zone`. On a `timestamptz`, `at time
  zone` removes the zone.
- Pass `--same-passkey-rp-id` only when the new app keeps the old relying
  party id; else the passkeys are dropped and listed. A passkey with a key, a
  counter, or a device field that core could not have written is refused and
  listed. A credential id on two users imports on neither, also when the two
  rows write it with and without base64 padding.
- `--password-column` names the app's own column of `User`. A name that no
  row has stops the run.
- Account rows other than `oauth` and `oidc` are dropped and listed.
- A `github` account imports as GitHub. A `linkedin` account of type `oidc`
  imports as LinkedIn. A `linkedin` account of type `oauth` is listed as
  `identity:linkedin_legacy`.

### Cognito

```bash
aws cognito-idp list-users --user-pool-id "$POOL" --output json > users.json
authtempo import cognito --users users.json --legacy-verify --target postgres --url-env DATABASE_URL
```

Set `password.legacyVerify` in the app (see `@authtempo/legacy-hashes`).
Without `--legacy-verify`, every marker is refused and the CLI exits 1.
Cognito exports no hash, so this command needs no `--formats`.

- Save the whole `list-users` output, `{ "Users": [...] }`. A bare array, as
  `--query Users` prints, stops the run.

- Cognito exports no hash, so a `CONFIRMED` user gets a marker, and core asks
  Cognito at the first sign-in. That no export gives the hash is unverified
  (runbook item 6).
- Every other status skips the user, and the reason names the status.
  `status_compromised` and `status_unknown` are conflicts. A federated user
  (`EXTERNAL_PROVIDER`) imports with no password.
- Only the built-in providers `Google` and `SignInWithApple` map to an
  identity. Any other is dropped and listed.
- A user with no `sub` is skipped as `no_source_id`. A `sub` on two users is
  `duplicate_row`. An `Enabled` value other than `true` skips the user.
- After the import, sign in once with a known user, and once with a user whose
  Cognito address has upper-case letters (runbook).

### WorkOS

The guide's script writes four JSON files with `curl` and `$WORKOS_API_KEY`
from the shell: see [the WorkOS guide](/docs/migrate/workos/). It saves the
`data` array of every list page, and one object of user id to the identities
array of each user. The CLI reads the files and makes no network call.

```bash
authtempo import workos --users users.json --identities identities.json --memberships memberships.json --organizations organizations.json --target postgres --url-env DATABASE_URL --dry-run
```

No password moves: WorkOS exports no hash. Each user signs in by a magic link
or sets a new password. This command needs no `--formats`.

- Only `--users` is required. `--memberships` and `--organizations` go
  together; one alone stops the run. A top-level value of another shape stops
  the run.
- `id` is the source id. `email`, `email_verified` (true only for the JSON
  value `true`), `name` (else `first_name` and `last_name` joined by one
  space), `profile_picture_url`, and `created_at` move. `external_id`,
  `metadata`, `locale`, and `last_sign_in_at` do not.
- An identity of `type` `OAuth` maps `GoogleOAuth` to Google, `AppleOAuth` to
  Apple, and `GitHubOAuth` to GitHub, with `idp_id` as the subject.
  `LinkedInOAuth` is listed as `identity:linkedin_legacy`, because no field
  marks the OIDC `sub`. Every other provider and every other type is dropped
  and listed.
- Only a membership with `status` `active` imports. Any other status is
  listed on its user as `member:<status>`. The role is `role.slug`: `admin`
  becomes admin and `member` becomes member, and the first admin becomes
  owner. A membership of an organization that the organizations file lacks
  is listed as `member:unknown_organization`.
- A user with no `id` is listed as `no_source_id`, a conflict. An `id` on two
  users is `duplicate_row`. The reader has no ban signal.
- Unverified (runbook item 13): the provider values other than
  `MicrosoftOAuth`, `idp_id` as the provider's own subject, the `statuses`
  query form, the `list_metadata.after` cursor of each list, and the rate
  limit.

## Targets

- `--target postgres`: core's tables (`@authtempo/adapter-postgres`).
- `--target postgres --tables compat`: an app that keeps the Better Auth 1.7 tables (`@authtempo/compat-better-auth`).
- D1: `--target d1-bundle --out <file>`, then the Worker script. `worker/README.md`
  names the bundle path and every step. The Worker prints the report and
  the CLI's exit status. It writes core's tables (`TARGET=core`, the
  default), or an app's Better Auth 1.7 tables on D1 with `--var
  TARGET:compat` (plan 9b2). `TARGET=compat` serves Better Auth's default
  table and column names only. An app with custom names (for example
  snake_case columns or plural tables) has no Worker path yet. The ready
  check reads only the unique index on the account table's (issuer,
  accountId). A custom name of that table or of those columns refuses with
  `schema_mismatch` before any write. Any other custom name passes the
  check, and the run stops with a D1 error at the first statement on that
  table: the failing record writes no row (its undo removes them), and the
  records before it stay. Do not run `TARGET=compat` on such an app. The
  `--tables compat` target on Postgres also uses the default names.

CAUTION: the D1 bundle holds every password hash and, for Supabase, the
Firebase signer key. The CLI writes it with mode 0600. Do not commit it, and
remove it after the Worker run as `worker/README.md` says.

Other options: `--reserved-slugs` (the app's `organizations.reservedSlugs`;
core's defaults stay reserved) and `--platform-slug` (the app's platform
organization slug; no import takes it). `authtempo import --help` prints
the full help.
