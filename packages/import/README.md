# @tempo-auth/import

Moves users, social identities (Google and Apple), password hashes, Auth.js
passkeys, organizations, and members into tempo-auth (spec 17). No session
moves from any source, and no MFA secret moves (spec 17.5). Passkeys move only
from Auth.js. A Clerk, Supabase, Auth0, Firebase, or Cognito passkey needs a
new enrolment.

```bash
tempo-auth-import <provider> [files] --formats <the seam's list> --postgres "$DATABASE_URL" --dry-run
```

Run `--dry-run` first. It prints the report a real run prints. The importer
writes only rows that a core flow writes: an address is verified only where
the export says so, and a social identity other than Google or Apple is
dropped and listed.

`--formats` is required, and it has no default. Give it the `formats` list
of the app's `createLegacyPasswordHash`, comma-separated, or `none` for an app
with no legacy seam. A hash in another format is refused and listed. The user
is then imported with no password, and a reset or a magic link signs that user
in. Only `cognito` may leave out `--formats`, because Cognito exports no hash.

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

Run the import again at any time: a second run of the same export writes
nothing, and a user that exists by its import id is never written again.
Some re-runs can list a user as `partial`, with the missing row kinds, and
the CLI then exits 1. These are a re-run after a claim, after another change
in the app, with a newer export, or with other options. Check each such user
in the app before any repair. The importer has no repair mode.

`--report <file>` also writes the report as JSON. The report file holds no
hash. It is written with mode 0600.

## The exports

Checked against each provider's docs on 2026-10-11. Check a real export
against the owner runbook in the plan index before you run it for real. A
fact below marked unverified is one item of that runbook.

### Supabase

Two CSV files from the database; the Admin API returns no hash:

```bash
psql "$SUPABASE_DB_URL" -c "\copy (select id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, is_anonymous, deleted_at, banned_until, is_sso_user from auth.users) to 'users.csv' with csv header"
psql "$SUPABASE_DB_URL" -c "\copy (select provider, provider_id, user_id from auth.identities) to 'identities.csv' with csv header"
tempo-auth-import supabase --users users.csv --identities identities.csv --formats bcrypt,argon2id --postgres "$DATABASE_URL"
```

- Every column of the two selects must be in the header. A missing column
  stops the run before any read, because an empty `banned_until` or
  `is_sso_user` would import a banned or SSO user.
- SSO (SAML) users are not imported. tempo-auth has no SAML mapping. Each one
  is listed as `sso_user`, and the CLI exits 0 on them.
- A `banned_until` that is not a time in the past skips the user as `banned`,
  also a value the reader cannot read, such as `infinity`.
- A phone-only user has no email and is skipped as `no_email`. Supabase
  passkeys do not move (spec 17.5).
- Rows with Supabase's `$fbscrypt$` tag need `--firebase-signer-key` and
  `--firebase-salt-separator`, the same values as the seam's `firebase`
  option, and `firescrypt` in `--formats`. A row of another Firebase project
  is refused and listed.
- Unverified: the base64 alphabet of Supabase's Argon2 rows, and `$fbscrypt$`
  rows with no `sk` (runbook item 2).

### Clerk

Two files, joined on the exact user id. The dashboard CSV (Settings, User
exports) has the password digests. `GET /v1/users` has the created date, the
external accounts, and the address flag. Fetch every page and join them into
one array:

```bash
set -euo pipefail
o=0; : > pages.ndjson
while :; do
  page=$(curl -sf -H "Authorization: Bearer $CLERK_SECRET_KEY" "https://api.clerk.com/v1/users?limit=500&offset=$o")
  [ "$(printf '%s' "$page" | jq length)" -eq 0 ] && break
  printf '%s\n' "$page" >> pages.ndjson
  o=$((o + 500))
done
jq -s 'add // []' pages.ndjson > users.json
tempo-auth-import clerk --csv export.csv --users users.json [--organizations organizations.json] --formats bcrypt --postgres "$DATABASE_URL"
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
tempo-auth-import auth0 --users users.ndjson [--hashes hashes.ndjson] [--organizations organizations.json] --role-map lead=admin --formats bcrypt --postgres "$DATABASE_URL"
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
- A user line or an organization with no id is listed as `no_source_id`, a
  conflict.
- Unverified: the hash algorithm (`$2b$10$` in every sample), the hash file's
  field list, and whether `user_id` carries `_id` or `alt_id` (runbook item
  4).

### Firebase

`firebase auth:export users.json --format=json`, and from the console
(Authentication, Users, "Password hash parameters") `rounds` and `mem_cost`:

```bash
tempo-auth-import firebase --users users.json --firebase-rounds 8 --firebase-mem-cost 14 --formats firescrypt --postgres "$DATABASE_URL"
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
tempo-auth-import authjs --tables tables.json --formats bcrypt [--password-column passwordHash] [--same-passkey-rp-id] --postgres "$DATABASE_URL"
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

### Cognito

```bash
aws cognito-idp list-users --user-pool-id "$POOL" --output json > users.json
tempo-auth-import cognito --users users.json --legacy-verify --postgres "$DATABASE_URL"
```

Set `password.legacyVerify` in the app (see `@tempo-auth/legacy-hashes`).
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

## Targets

- `--postgres <url>`: core's tables (`@tempo-auth/adapter-postgres`).
- `--postgres <url> --better-auth`: an app that keeps the Better Auth 1.7
  tables (`@tempo-auth/compat-better-auth`).
- D1: `--d1-bundle <file>`, then the Worker script. `worker/README.md`
  names the bundle path and every step. The Worker prints the report and
  the CLI's exit status. It writes core's tables only, through core's D1
  adapter. An app that keeps the Better Auth tables on D1 has no import path
  yet (a plan 9c input).

CAUTION: the D1 bundle holds every password hash and, for Supabase, the
Firebase signer key. The CLI writes it with mode 0600. Do not commit it, and
remove it after the Worker run as `worker/README.md` says.

Other options: `--reserved-slugs` (the app's `organizations.reservedSlugs`;
core's defaults stay reserved) and `--platform-slug` (the app's platform
organization slug; no import takes it). `tempo-auth-import` with no
arguments prints the full usage.
