# @tempo-auth/import

Moves users, social identities (Google and Apple), password hashes, Auth.js
passkeys, organizations, and members into tempo-auth (spec 17). Sessions,
MFA secrets, and passkeys from Clerk, Supabase, Auth0, and Firebase do not
move: every provider's own guide ends the sessions at cutover, and a passkey
needs a new enrolment.

```bash
tempo-auth-import <provider> [files] --postgres "$DATABASE_URL" --dry-run
```

Run `--dry-run` first. It prints the report a real run prints. The importer
writes only rows that a core flow writes: an address is verified only where
the export says so, and a social identity other than Google or Apple is
dropped and listed.

The app's password seam must verify the formats you import: pass the same
list to `--formats` and to `createLegacyPasswordHash` (default all five). A
hash in another format is refused and listed, and the user is imported with
no password. A reset or a magic link signs that user in.

## The exit status and the report

| Status | When |
| --- | --- |
| 0 | Clean. A skip that the export states (anonymous, deleted, disabled, banned, a Supabase SSO user, a Cognito user that is not confirmed) is listed and does not count. |
| 1 | A person must look: a refused hash, a refused record (`invalid_` or `reserved_` reasons), a conflict, or a `partial` record. |
| 2 | A usage error, a malformed input file, or a stop. A stop prints one `stopped:` line. A stop before the first write says "nothing was written". A stop during the run (a storage error, or `--on-email-taken fail`) keeps the records before it, and a re-run counts them as `exists`. |

The conflicts are `unmatched_row`, `duplicate_row`, `status_compromised`,
`status_unknown`, `no_source_id`, `email_taken`, `identity_taken`,
`slug_taken`, `no_owner`, `duplicate_passkey`, and `user_not_imported`
(`CONFLICT_REASONS` in `src/types.ts`). The import never merges two accounts:
a taken address or identity skips the record, or with `--on-email-taken fail`
stops the run.

Run the import again at any time: a second run of the same export writes
nothing, and a user that exists by its import id is never written again. A
re-run after a claim, after another change in the app, with a newer export,
or with other options can list a user as `partial` with the missing row
kinds, and the CLI exits 1. Check each such user in the app before any
repair. The importer has no repair mode.

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
tempo-auth-import supabase --users users.csv --identities identities.csv --postgres "$DATABASE_URL"
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
  option. A row of another Firebase project is refused and listed.
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
tempo-auth-import clerk --csv export.csv --users users.json [--organizations organizations.json] --postgres "$DATABASE_URL"
```

- `organizations.json` is an array of `GET /v1/organizations` objects, each
  with a `memberships` array from `GET /v1/organizations/{id}/memberships`.
  `org:admin` becomes `owner`. A file that is not a JSON array stops the run.
- A user in one file and not in the other is listed as `unmatched_row`. An id
  that one file holds twice is listed as `duplicate_row`, and no copy imports.
- Only a `password_hasher` of `bcrypt` imports. Any other value is refused by
  its name. A `banned` value other than `false` skips the user.
- Unverified: the unit of `created_at` (a value below 1e11 is read as
  seconds, else milliseconds), the `password_hasher` values of a real export,
  and the `banned` field (runbook item 3).

### Auth0

The user export job (`POST /api/v2/jobs/users-exports`, format `json`) gives
NDJSON. The password hashes come only through a support case, as a
PGP-encrypted file; decrypt it, then pass it as `--hashes`. Without
`--hashes`, the CLI prints one line and imports no password.

```bash
tempo-auth-import auth0 --users users.ndjson [--hashes hashes.ndjson] [--organizations organizations.json] --role-map lead=admin --postgres "$DATABASE_URL"
```

- A hash line is used only when exactly one user matches `auth0|<_id>` (or
  `alt_id`) and the addresses are equal. Else the line is listed as
  `unmatched_row`, or the hash is refused as `hash_email_mismatch`.
- Only a `$2a$` or `$2b$` hash imports. Any other is refused by its format.
- Auth0 roles have no default map. Map your role names with `--role-map`. An
  unmapped role becomes `member`. An organization with no owner gets its
  first admin as owner; with no admin it is skipped as `no_owner`.
- A `blocked` value other than `false` skips the user as `banned`.
- Unverified: the hash algorithm (`$2b$10$` in every sample), the hash file's
  field list, and whether `user_id` carries `_id` or `alt_id` (runbook item
  4).

### Firebase

`firebase auth:export users.json --format=json`, and from the console
(Authentication, Users, "Password hash parameters") `rounds` and `mem_cost`:

```bash
tempo-auth-import firebase --users users.json --firebase-rounds 8 --firebase-mem-cost 14 --postgres "$DATABASE_URL"
```

- The signer key and the salt separator go to the seam's `firebase` option,
  not to the CLI.
- `rounds` and `mem_cost` that break the scrypt memory bound (2^mem_cost
  times rounds at most 2^18) stop the run before any read.
- The reader cannot detect a hash made with another project's parameters.
  The export carries none to compare. A wrong value refuses every first
  sign-in with no report line. Sign in once with a known user before the
  cut-over.
- A `disabled` value other than `false` skips the user.
- Unverified: the JSON type of `createdAt` and the `{ "users": [...] }`
  wrapper (runbook item 5).

### Auth.js

One JSON object of the adapter tables (Postgres with Prisma names). Prisma
stores `emailVerified` as a timestamp with no time zone. The reader needs the
zone, so the select adds it. Without the zone, every user imports unverified
and the report lists `email_verified:unreadable`:

```bash
psql -At "$DATABASE_URL_OLD" -c "select json_build_object('users', (select coalesce(json_agg(to_jsonb(u) || jsonb_build_object('emailVerified', u.\"emailVerified\" at time zone 'UTC')), '[]') from \"User\" u), 'accounts', (select coalesce(json_agg(a), '[]') from \"Account\" a), 'authenticators', (select coalesce(json_agg(x), '[]') from \"Authenticator\" x))" > tables.json
tempo-auth-import authjs --tables tables.json [--password-column passwordHash] [--same-passkey-rp-id] --postgres "$DATABASE_URL"
```

- When the `emailVerified` column is already `timestamptz`, use `u` in place
  of the `to_jsonb(...)` expression. `at time zone` on a `timestamptz` removes
  the zone.
- Pass `--same-passkey-rp-id` only when the new app keeps the old relying
  party id; else the passkeys are dropped and listed. A passkey with a key, a
  counter, or a device field that core could not have written is refused and
  listed. A credential id on two users imports on neither.
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
  names the bundle path and every step. The Worker prints the report.

CAUTION: the D1 bundle holds every password hash and, for Supabase, the
Firebase signer key. The CLI writes it with mode 0600. Do not commit it, and
remove it after the Worker run as `worker/README.md` says.

Other options: `--reserved-slugs` (the app's `organizations.reservedSlugs`;
core's defaults stay reserved) and `--platform-slug` (the app's platform
organization slug; no import takes it). `tempo-auth-import` with no
arguments prints the full usage.
