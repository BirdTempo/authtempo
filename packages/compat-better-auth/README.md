# @authtempo/compat-better-auth

Run an app written for Better Auth 1.7 on authtempo. The app keeps its code
and its tables. A package alias points the Better Auth package names at this
package.

## The alias

pnpm and npm, in the app's `package.json`:

```json
{
  "dependencies": {
    "better-auth": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/drizzle-adapter": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/expo": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/passkey": "npm:@authtempo/compat-better-auth@0.0.0",
    "@authtempo/core": "0.0.0",
    "@authtempo/client": "0.0.0",
    "@authtempo/handoff": "0.0.0",
    "@authtempo/adapter-d1": "0.0.0",
    "@authtempo/adapter-postgres": "0.0.0"
  }
}
```

yarn (classic and berry) reads the same `npm:` form. Both adapters are
required peers, also in an app that uses one database: the server entry
loads both. Neither has a runtime dependency.

Map only the names the app imports. A Better Auth package with no alias, for
example `@better-auth/api-key`, stays the real package, and `betterAuth`
refuses its plugin by id at construction.

| Import in the app | Answered by |
| --- | --- |
| `better-auth` | `.` |
| `better-auth/plugins` | `./plugins` |
| `better-auth/react` | `./react` |
| `better-auth/client` | `./client` |
| `better-auth/client/plugins` | `./client/plugins` |
| `better-auth/adapters/drizzle`, `@better-auth/drizzle-adapter` | `./adapters/drizzle` and `.` |
| `better-auth/node` | `./node` |
| `better-auth/api` | `./api` (`APIError`) |
| `better-auth/next-js` | `./next-js` |
| `@better-auth/expo` | `.` (`expo`) |
| `@better-auth/expo/client` | `./client` (`expoClient`) |
| `@better-auth/passkey` | `.` (`passkey`) |
| `@better-auth/passkey/client` | `./client` (`passkeyClient`) |

`better-auth/api` maps to `./api`, which exports `APIError` only (plan 9b).
An import of another name from it, such as `createAuthMiddleware`, fails at
build: core has no request hooks (plan 9d). Wrap the handler instead (see
"Request hooks").

The package exports no other subpath. An import of `better-auth/db`,
`better-auth/types`, `better-auth/plugins/access`, or
`better-auth/plugins/organization/access` fails at build. consumerc, consumerd,
and consumerb import some of them: remove those imports first.

## Passwords from Better Auth

`betterAuthPasswordHash` verifies a Better Auth scrypt hash and rewrites it as
PBKDF2 on the first right sign-in. A legacy row verifies slower than a PBKDF2
row until that sign-in rehashes it. So during the migration window the
response time shows which accounts are not yet migrated. Each account loses
this tell at its first right sign-in.
At most two legacy derives run at once per isolate, also when the app chains
`@authtempo/legacy-hashes` before this seam: both use core's `deriveGate`.
The others wait, and no sign-in is refused.

`requireEmailVerification: true` maps to core's `password.requireVerified`
(plan 12b). A sign-up opens no session and answers `{ token: null, user }`.
`api.signUpEmail` answers a taken address with the same shape and a new
synthetic user, as Better Auth does. The handler route and the client still
answer `USER_ALREADY_EXISTS` (409) for it. A right password of an unverified
address answers
`EMAIL_NOT_VERIFIED` (403). Core mails a new verify link at each unverified
sign-in, at most 3 per 15 minutes, also when `sendOnSignIn` is absent. An app
that leaves `sendOnSignIn` out now gets that mail, where Better Auth sends
none.

## Storage: in place on the Better Auth tables

`drizzleAdapter(db, { provider: "pg", schema })` and
`betterAuthSchemaStorage({ dialect: "postgres", sql })` answer core's storage
port and the owned limiter over the app's existing Better Auth 1.7 tables.
Postgres needs a postgres.js client; with Drizzle that is
`drizzle-orm/postgres-js`. Other drivers are refused.

Run the migration once per deploy, before the first request:

```ts
await betterAuthSchemaStorage({ dialect: "postgres", sql }).migrate();
```

What the migration does (`0001_compat_better_auth`, append-only):

- It adds two tables, `ta_meta` and `ta_limit`, and no other table. A schema that already holds core's own `ta_meta` and `ta_limit` (from `@authtempo/adapter-postgres` migrations) makes `migrate()` stop with `relation "ta_limit" already exists`, and the migration changes nothing. Run the compat storage on a schema without core's tables.
- It adds nullable `ta` columns for core fields with no Better Auth column: `session.taLastSeenAt`, `account.taLinkedAt`, `verification.taPurpose`, `taValueHash`, `taConsumedAt`, `taData`, `passkey.taUpdatedAt`, `organization.taUpdatedAt`, `member.taUpdatedAt`, `invitation.taTokenHash`, `taAcceptedAt`, `taUpdatedAt`.
- It fills the date columns `session.taLastSeenAt`, `account.taLinkedAt`, and the four `taUpdatedAt` columns for existing rows from the nearest Better Auth date (`session.updatedAt`, else `createdAt`), cut to milliseconds. On Postgres these columns also get the default `date_trunc('milliseconds', now())`, so a row that another writer adds later (an old replica during the deploy, the app's own SQL) has a value. Without a value core cannot read the row. The milliseconds matter: core reads dates with millisecond precision, and the organization owner guard compares the read value for equality.
- The other `ta` columns stay null on rows that authtempo did not write. Core reads only verification rows with a `taPurpose` and invitations with a `taTokenHash`.
- It adds the unique keys core needs: `verification (taValueHash)`, `passkey (credentialID)`, `member (organizationId, userId)`, `invitation (taTokenHash)`, and `account (issuer, accountId)` when the table has no unique index on these two columns under any name (Better Auth 1.7 has `account_issuer_accountId_uidx`).
- `account.issuer` on both dialects: on Postgres it adds the column when it is missing (a table from before Better Auth 1.7, such as consumer-i's) and fills every row that has none from `providerId`. On D1 a static file cannot test for a column, so two files ship: `migrations/d1/` for 1.7 tables (it fills only) and `migrations/d1-before-1.7/` (it adds the column and the unique index, then fills). Copy the one that fits the tables, as the D1 steps below say.
- It stops with "every Better Auth date column must be timestamptz" when a date column has no time zone.
- It needs every table in the list, also when the plugin is off: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `passkey`. Create a missing table with Better Auth's own SQL for it. Core's claim rule deletes passkey rows on every app, and the sweep deletes invitations.

Migration `0002_compat_schema_v5` (plan 8b) moves `schema_version` to 5 and `compat_better_auth` to 2. It changes no table: core 5 adds API tokens, and this package does not hold them until its api-key plan. Core's routes under `/tokens` answer 404 here. `tempo.api.tokens.*` is not usable on this storage: `create` throws `unknown_model`, and the reads answer empty. `migrate()` runs both migrations. On D1, copy `0002_compat_schema_v5.sql` after the 0001 file, for both variants and every naming: it touches `ta_meta` only. Without it the storage refuses to start with `schema_mismatch`.

What changes at cutover:

- The `session.token` column holds the SHA-256 hex of the token, never the raw token. Better Auth-era sessions end: every person signs in again once. App SQL that reads `session.token` reads a hash.
- Better Auth-era verification rows and invitations stay in the table and core never reads them. Send pending invitations again.
- Users, Google, Apple, GitHub, and LinkedIn accounts, credential passwords, organizations, members, and passkeys carry over. A password rehashes to PBKDF2 at its first sign-in.
- The `ta_meta` and `ta_limit` tables go in the first schema of the search path, also when the Better Auth tables sit in another schema.
- A passkey counter above 2147483647 fails: Better Auth's `counter` column is `integer`.
- The session cookie is `__Host-tempo_session`, not `better-auth.session_token`. For one release the shim also reads `tempo_session`, the name of plan 9, and moves it: the handler sets `__Host-tempo_session` with the same token and clears `tempo_session`. `api.getSession` reads the old name too, but sets no cookie. App code, tests, and legal pages that name the old cookie must change. For example, consumer-i's site lists `__Secure-better-auth.session_token` in its cookie text (`apps/site/test/legal.test.ts`).
- Better Auth-era `account` rows of providers that the package does not map (any provider other than Google, Apple, GitHub, and LinkedIn) stay in the table. Core reads them as identities of their users, so a claim of the address deletes them as it deletes any identity other than the proving one. The factory refuses such a provider in `socialProviders` with the reason `not mapped; add it through core's social.oidc or social.oauth2`. On core's `createAuth`, a list entry whose `name` is the Better Auth provider id and whose subject is the id that Better Auth stored as `accountId` links these rows on the first sign-in. A compat app that needs such a provider uses core's `createAuth` for it, because `betterAuth()` takes no list entry.
- Register `<baseURL><basePath>/social/<provider>/callback` at each provider (Google, Apple, GitHub, LinkedIn) before cutover. Better Auth used `<baseURL>/api/auth/callback/<provider>`. A GitHub OAuth App has one callback URL, so change it at cutover, or use a GitHub App, which takes several. Google and LinkedIn take a list, so add the new URI before cutover.
- GitHub and LinkedIn accounts link on the first sign-in by the id Better Auth stored: the numeric GitHub id, and LinkedIn's OpenID `sub`. LinkedIn's `sub` stays the same only while the client id stays the same.
- A credential row (`providerId` `credential`) with a null `account.password` answers `schema_mismatch`, so sign-in and reset for that address answer 500. Better Auth 1.7.2 never writes that row. Give the row a hash or delete it before cutover. A plan 9b input.

On D1, `drizzleAdapter(db, { provider: "sqlite" })` needs `drizzle-orm/d1`, and
`betterAuthSchemaStorage({ dialect: "d1", db: env.DB })` takes the binding.

The one D1 step: copy the compat file into the app's `migrations_dir`, and
rename it to the app's next migration number, for example
`0007_compat_better_auth.sql` after `0006_...`. Then run
`wrangler d1 migrations apply`. wrangler applies the files in name order. A
number lower than the Better Auth table migration makes every new database
(CI, a preview database, `--local`) fail at the compat file with
`no such table`.

- Better Auth 1.7 tables: copy `node_modules/@authtempo/compat-better-auth/migrations/d1/0001_compat_better_auth.sql`.
- Tables from before Better Auth 1.7 (no `account.issuer` column): copy the file of the same name from `migrations/d1-before-1.7/`.
- Every app: then copy each later file of the same directory (`0002_compat_schema_v5.sql` to `0009_compat_schema_v12.sql`), in order, and give each the next number.
- Tables with other names: write the 0001 file from `storage.migrationSql()` or `storage.migrationSql("before-1.7")`. Write the 0006 file from `compatMigration0006Sql("sqlite", storage.names)`, not from the shipped file. The shipped 0006 adds `taSecretVersion` to Better Auth's default `verification` table, so on other names it fails with `no such table`. Write the 0007 file from `compatMigration0007Sql("sqlite", storage.names)` for the same reason: the shipped 0007 adds `taFreshAt` to the default `session` table. Write the 0009 file from `compatMigration0009Sql("sqlite", storage.names)` for the same reason. The shipped 0009 adds the ban columns to the default `user` table and `taActorId` to the default `session` table.

`wrangler d1 migrations apply` rolls back a file that fails (wrangler
4.148.0, read 2026-10-10), so a refused file changes nothing. A runner that
does not roll back, such as `wrangler d1 execute --file`, can keep the empty
`ta_date_check` table of a refused date check. The next run uses that table
and drops it. The errors that a refused file gives:

- `no such column: issuer`: the 1.7 file on tables from before 1.7. Use the `d1-before-1.7` file.
- `duplicate column name: issuer`: the `d1-before-1.7` file on 1.7 tables. Use the `d1` file.
- `table ta_limit already exists`: the compat migration ran already.
- `CHECK constraint failed: tempo_auth_compat_every_better_auth_date_must_be_text`: a Better Auth date column holds a number (a Drizzle `integer({ mode: "timestamp" })` schema) or text that is not a date. authtempo on D1 reads dates as ISO 8601 text only.

Dates are ISO 8601 text and booleans are 1 and 0, as Better Auth's Kysely
adapter writes them. The migration fills the added dates as ISO text with
milliseconds, also from SQLite's `YYYY-MM-DD HH:MM:SS` form. SQLite gives an
added column no computed default, so when another writer adds a row later,
the storage reads `createdAt` (`updatedAt` for a session) in place of the
added date. `drizzleAdapter` refuses a Drizzle SQLite schema with integer
timestamp columns. The storage also refuses every call with `schema_mismatch`
while `account` has no unique index on (issuer, accountId): the 1.7 file uses
Better Auth's own index and adds none.

A Better Auth date in SQLite's `YYYY-MM-DD HH:MM:SS` form has no time zone.
The storage reads it as UTC, as SQLite's date functions do, on Workers and
off them (plan 9b2). A where clause and a sort still compare the stored text,
so a row in that form sorts before an ISO row of the same second. A date text
that is not a date answers `schema_mismatch`. The storage does not match the
`YYYY-MM-DD HH:MM` form with no seconds. SQLite's `CURRENT_TIMESTAMP` never
writes it, but SQL written by hand can. JavaScript reads that text as local
time: on Workers, whose time zone is UTC, the read is correct; in a process
with another time zone it is wrong by the zone offset (probe with Node and
`TZ=Pacific/Auckland`, 2026-10-12). Write each date with its seconds.

A `credential` account row with a null `password` (Better Auth never writes
one) reads as no password row: the sign-in answers `invalid_credentials`
after the dummy verify, a reset writes a real hash, and the storage logs one
line, `authtempo compat: a credential account row has no password; it reads
as no password row (account <id>)`.

On D1, do not delete a user or an organization inside a `transaction` of
your own while its child rows exist: the foreign keys delete them, and a
rollback does not bring them back (`@authtempo/adapter-d1` README).

These D1 facts come from the local Workers pool only and are not verified on
a real D1 database: D1 refuses TEMP tables, D1 refuses a long compound
SELECT, the PRAGMA column names, the rollback of a failed migration file, and
the time of the one date scan statement on a large table (it can reach D1's
per-query limit). A plan 9b input verifies them on a real D1 database.

## What fails at start

`betterAuth(options)` checks every option against an allow list. One
`BetterAuthCompatError` lists every option, plugin, and provider that
authtempo cannot keep, so the app fails at start and never at run time. The
error's `refusals` holds the list. Options that change only speed, such as
`session.cookieCache`, are accepted and log one line.

Better Auth's defaults apply: a session lives 7 days and refreshes after 1 day,
a reset link lives 1 hour, a magic link 5 minutes, an invitation 2 days.

Better Auth defaults that core does not keep:

| Better Auth default | authtempo |
| --- | --- |
| The client IP comes from `x-forwarded-for` | It comes from `cf-connecting-ip`. Set `advanced.ipAddress.ipAddressHeaders` off Workers: off Workers any caller sets `cf-connecting-ip`, so every per-IP limit can be rotated. `toNodeHandler` and `toNextJsHandler` throw `BetterAuthCompatError` at creation for an instance with neither a non-empty `ipAddressHeaders` nor `disableIpTracking: true`. A listed header value that is not an IPv4 or IPv6 literal counts as no client IP. For a header with a list of values, such as `x-forwarded-for`, the shim takes the leftmost value, as Better Auth does. A client can write that value, so list only a header that your proxy sets in full. A request with no client IP (a server call with no headers, or every request under `disableIpTracking: true`, which logs a note) skips the per-IP limit only for password sign-in, the magic link, the reset request, and the verify mail resend, which keep their per-email limits. Every other flow (sign-up, the reset form, invitation accept, the handoff, passkeys, social start) has only a per-IP limit, so it counts all such requests in one shared bucket. |
| An absolute `callbackURL` or `redirectTo` on any trusted origin | Only the origin of `authtempo.appURL` (default the origin of `baseURL`) keeps its path, because core lands every sign-in there. Any other absolute value answers `INVALID_CALLBACK_URL` or `INVALID_REDIRECT_URL`, status 403. |
| A reset keeps the other sessions | A reset ends every session. |
| The verify link lives 1 hour beside a magic link of 5 minutes | Both live as long as the magic link. With the magic link plugin and no `emailVerification.expiresIn`, the verify link lives 300 s, not 3600 s, and a note says so at start. |
| `trustedOrigins` takes a function and wildcards such as `https://*.example.com` | Each entry is an exact origin (`https://app.example.com`, no path or trailing slash) or an app scheme (`myapp://`). Any other entry is refused at start. |

Call arguments that core cannot keep: on the server, `api.signUpEmail` with
`callbackURL` or `image`, and `api.signInEmail` with `callbackURL` or
`rememberMe: false`, throw `APIError` `NOT_SUPPORTED` with status 501. Core's
verify link lands on the app origin, and every session lives
`session.expiresIn`. `rememberMe: true` is Better Auth's default and is
accepted. The client answers the same `NOT_SUPPORTED` (501) for `callbackURL`
on `signIn.email` and `signUp.email` and for `rememberMe: false`, and sends no
request.

Two-factor (plan 9f): the error codes are Better Auth 1.7.2's (`INVALID_CODE`,
`INVALID_BACKUP_CODE`, `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`,
`INVALID_TWO_FACTOR_COOKIE`, `TOTP_NOT_ENABLED`, `TWO_FACTOR_NOT_ENABLED`,
`INVALID_PASSWORD`), with core's status: 400 for a wrong code, where Better
Auth answers 401. A missing or stale `better-auth.two_factor` cookie answers
`INVALID_TWO_FACTOR_COOKIE` with 401. A second enable answers
`TOTP_ALREADY_ENABLED` (409), where Better Auth replaces the secret: disable
first. A challenge lives 5 minutes, where Better Auth's cookie lives 10.
`api.signInEmail` answers `{ twoFactorRedirect: true, twoFactorMethods:
["totp"] }`; its type says so only when the options name the plugin in a
literal list. The backup codes of a Better Auth user do not move: each user
sets the factor up again on authtempo. A new `secret` opens no sealed secret,
so every user with the factor on fails the code and the backup codes until the
factor is turned off for them. The setup takes the password at every path:
`/two-factor/enable` passes it into core's setup, and core's own `POST
/totp/setup` takes `{ password }` too, so a session alone sets up no factor. A
wrong password answers `INVALID_PASSWORD` (400) and writes no row. The limits
that bind are per user, on every code check: 10 per 15 minutes and 30 per 24
hours. A person who has the password or a stolen session can use up that
budget, and the owner's verify, enable, and disable then answer
`TOO_MANY_REQUESTS` until the window ends, as with Better Auth's lockout.
`api.signInEmail` reads `better-auth.trust_device` from `headers`, so a
trusted device signs in with no challenge. A gated server sign-in keeps no
challenge, because a server caller has no cookie jar: the browser repeats the
sign-in through the handler. Since plan 12c a reset by code of a user with the
factor on answers `{ success: true }` with no cookie, and the next sign-in asks
for the factor: Better Auth's own shape. On a trusted device the reset opens
the session, as the sign-in does. A reset link goes to core's page, which then
shows core's challenge page. The client's
`resetPassword({ newPassword, token })` answers `{ status: true }` for a gated
reset and leaves core's challenge live for 5 minutes; only the holder of the
reset link can reach it.

An invitation has two ids. The mail id (`data.id` in `sendInvitationEmail`)
accepts the invitation, and the row id (from `api.createInvitation`) cancels it.

`api.sendVerificationEmail` and `authClient.sendVerificationEmail` send a new
verify link through core's resend route (plan 8b). The earlier link of the
address stops working. A `callbackURL` answers `NOT_SUPPORTED` (501): core lands
the link on the app origin.

`emailVerification.sendOnSignIn: false` is refused at start: core sends a new
verify link at each unverified sign-in, at most 3 per 15 minutes. Absent and
`true` are accepted.

### Secrets and sign-up

These rules come from plan 12b.

- `secrets: [{ version, value }]` maps to core's `secrets`, one entry for one
  entry, the current version first. Give `secret`, `secrets`, or both, as in
  Better Auth.
- `secrets[i].version` 0 is refused: core reads a row from before plan 12b as
  version 1, so renumber from 1. Better Auth accepts version 0.
- With `secret` and `secrets`, version 1 must be the value of `secret`.
  Another value is refused at `secrets[i].value`. Core refuses every other
  bad entry, and the error names it as `config: <reason>`.
- The shim does not read the `BETTER_AUTH_SECRETS` environment variable: it
  maps options only. Pass the list as `secrets`.
- Core refuses a weak secret at start, where Better Auth only warns. Each
  value needs 32 characters or more. The current value (`secrets[0]`, or
  `secret` without `secrets`) also needs an estimated 100 bits of entropy.
  Make a new one with `openssl rand -base64 32`. An older version needs only
  the 32 characters, so an old secret of that length can stay as version 1
  behind a new current value.
- `emailAndPassword.autoSignIn: false` alone is refused: core opens a session
  at sign-up unless `requireEmailVerification` is true. With
  `requireEmailVerification: true` it is accepted, because Better Auth then
  acts as with that key alone: no session at sign-up, and an unverified
  sign-in is refused.
- The sign-up answer is Better Auth's: a session for a new address unless
  `requireEmailVerification` is true, and `USER_ALREADY_EXISTS` for a taken
  one. The shim sets core's
  `password.uniformSignUp: false`, because core's uniform answer has no user
  for Better Auth's `{ token, user }`. So a caller can learn that an address
  has an account, as with Better Auth. Use core's `createAuth` for the
  uniform answer.
- A sign-up of a new address writes rows and sends the verify mail. A taken
  address does neither, so the answer time can show that the address has an
  account, as in Better Auth.
- `disableSignUp` is accepted on `emailAndPassword`, `magicLink`, `emailOTP`,
  and each social provider. Core has one sign-up rule for every method.
  `true` on every configured method and provider that creates a user maps to
  core's `signUp: false`. `true` on some and not on others is refused at
  `disableSignUp`, and the reason names both groups: set it on every method
  or on none. A provider without the key counts as open.
- A provider's `disableImplicitSignUp` is refused: core has no sign-up that
  the caller asks for, so its one `signUp` rule covers every method.
- With `signUp: false`, `api.signUpEmail` throws
  `EMAIL_PASSWORD_SIGN_UP_DISABLED` with 400, Better Auth's code and status.
  The client's `signUp.email` answers the same code with core's status, 403.
  The other methods answer core's `sign_up_closed` as `SIGN_UP_CLOSED`.

Errors: `APIError` on the server and `error` on the client carry Better Auth's
code (`body.code`, `error.code`) and core's HTTP status. The table is
`BETTER_AUTH_CODES`.

## The session read

`auth.api.getSession` and `GET /get-session` answer `{ session, user }`, or
`null` with no session (plan 12a). `session.deferSessionRefresh: true` maps
to core's `session.deferRefresh`.

- A GET request writes no session row. `GET /get-session` and `api.getSession` answer `needsRefresh` beside the session.
- `POST /get-session` slides the expiry and renews the cookie through core's `POST /session/refresh`.
- With the option off, `POST /get-session` answers `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` (405), as Better Auth 1.7.2 does.

The handler forwards each request to core's own route, so core's rules
apply. The shim's client reads core's `GET /session`. When the answer holds
`needsRefresh: true`, the client posts core's `POST /session/refresh` and
keeps the GET answer if that post fails, as Better Auth's session atom does.

## Account operations

Plan 12a serves Better Auth 1.7.2's account operations in Better Auth's
shapes. Each is a method of `auth.api` and a path of `auth.handler`.

| Better Auth call | Path | Answer |
| --- | --- | --- |
| `listSessions` | `GET /list-sessions` | The live sessions; `token` holds the session id |
| `revokeSession({ token })` | `POST /revoke-session` | `{ status: true }`, also for an unknown token |
| `revokeSessions` | `POST /revoke-sessions` | `{ status: true }`; every session ends, the caller's too |
| `revokeOtherSessions` | `POST /revoke-other-sessions` | `{ status: true }` |
| `updateUser({ name, image })` | `POST /update-user` | `{ status: true }` |
| `changeEmail({ newEmail, callbackURL })` | `POST /change-email` | `{ status: true }`, with `user.changeEmail.enabled` |
| `deleteUser({ password })` | `POST /delete-user` | `{ success: true, message: "User deleted" }`, with `user.deleteUser.enabled`. With `sendDeleteAccountVerification`: `{ success: true, message: "Verification email sent" }` |
| `deleteUser({ token })` | `POST /delete-user` | `{ success: true, message: "User deleted" }`: the confirm of the mailed link |
| The mailed link (the handler only) | `GET /delete-user/callback` | Core's confirm page. It deletes nothing; its button posts the token |
| `listUserAccounts` | `GET /list-accounts` | The provider accounts and the credential account |
| `linkSocial` (the handler only) | `POST /link-social` | `{ url, redirect }` |
| `unlinkAccount({ accountId })` | `POST /unlink-account` | `{ status: true }` |

The handler posts core's own route for each path, so core's Origin rule,
its fetch-metadata rule, CORS, and the cookie renewals apply. The handler
runs core's Origin and fetch-metadata rules on every POST first, also on the
paths that the shim answers itself. A refused POST answers 403
`{ "code": "INVALID_ORIGIN", "message": "Invalid origin" }`, as Better Auth's
origin check does. The check runs before the route, so a refused POST to a
path that no route serves answers 403, not 404. `auth.api` calls core in
process. Both run the same Better Auth checks. A refusal of
such a check changes no row. It carries no CORS header, as on the email
code and second-factor paths. The shim's own client
gains no account calls. A client app posts these paths, or calls
`@authtempo/client`.

| Difference | Why |
| --- | --- |
| `listSessions` answers the session id in `token`. `revokeSession` takes that id or a clear token | The shim stores the hash of a token, never the token |
| A revoke of the caller's own session through the handler clears the session cookie, as `revokeSessions` does | Core's rule for a request that ended its own session |
| A revoke, the change of address, the link, the unlink, and the delete need a fresh session. A stale session answers `SESSION_NOT_FRESH` (403) | ASVS 5.0.0 7.5.1 and 7.5.2. `session.freshAge` sets the window: default one day, rounded up to whole minutes |
| `/two-factor/disable`, `/two-factor/get-totp-uri`, and `/two-factor/generate-backup-codes` need a fresh session too, checked before the password. A stale session answers `SESSION_NOT_FRESH` (403) | A password and a stolen session must not turn the factor off. Better Auth asks for the password only |
| `listSessions` needs no fresh session, where Better Auth asks for one | A person can always view the sessions (ASVS 5.0.0 7.5.2) |
| A core route through the handler, such as `POST /password/change`, adds `code: "SESSION_NOT_FRESH"` to core's 403 answer | The caller reads Better Auth's code on every path |
| `session.freshAge: 0` is refused | The fresh rule is a promise of core |
| `deleteUser({ password })` re-authenticates first. A wrong password answers `INVALID_EMAIL_OR_PASSWORD`, not `INVALID_PASSWORD` | Better Auth's password path skips `freshAge`. Core's re-authentication proves the password, and the code too when the second factor is on |
| `GET /delete-user/callback` serves core's confirm page and deletes nothing. The page posts the token with the session cookie. `url` of `sendDeleteAccountVerification` opens that page on core's path, and `request` is undefined | A mail scanner fetches links, so a GET that deletes lets it delete the account |
| With `sendDeleteAccountVerification`, the request needs a fresh session, as the direct delete does. The organization rule runs at the request and again at the confirm | Core keeps every check of the delete. Better Auth mails the link with no check |
| `deleteTokenExpiresIn` is a whole number of minutes from 300 to 86400 seconds. Else the option is refused | Core keeps the life of the link in whole minutes, from 5 to 1440 |
| A spent, expired, unknown, or foreign token answers `INVALID_TOKEN` with 400, not 404. A confirm after a change of address answers it too | Core's status. The link went to the old mailbox |
| `deleteUser` with `callbackURL` answers `NOT_SUPPORTED` (501). The confirm page lands on the app | Core lands a form post on `appURL` |
| An organization where the user is the last owner and other members remain stops the delete: `SOLE_OWNER` (409) | Better Auth keeps such an organization with no owner |
| `updateUser` takes `name` and `image`, for a verified address only. `email` answers `EMAIL_CAN_NOT_BE_UPDATED`, and any other field `FIELD_NOT_ALLOWED` | Core keeps no other user field. Better Auth drops an unknown field |
| The change of address mails the new address through `emailVerification.sendVerificationEmail`. A taken address gets no mail. The link opens core's confirm page | As Better Auth does. Core moves the address only after the proof. `sendChangeEmailConfirmation` is refused |
| `changeEmail` with the option off answers `CHANGE_EMAIL_DISABLED` (400). Core's own `/user/change-email` routes answer 404 | Better Auth 1.7.2's answer |
| A link needs the provider's verified address, equal to the account's. Else the callback answers `email_mismatch`. `allowDifferentEmails: true` and `trustedProviders` are refused | Better Auth also links an unverified address of a trusted provider, and a different address with `allowDifferentEmails`. A provider address must not take an account |
| `unlinkAccount` keeps the last way in: `FAILED_TO_UNLINK_LAST_ACCOUNT` with 409, where Better Auth answers 400. `allowUnlinkingAll: true` is refused | The last-credential guard |
| `unlinkAccount` of the credential account answers `NOT_SUPPORTED` (501) | Core has no password removal |
| `linkSocial` takes `provider`, `callbackURL`, and `disableRedirect`. Each other field answers `NOT_SUPPORTED` (501) | Core starts a redirect link with its own scopes and its own error page |
| Core's credential-change notices are off under the shim: `account.notices: false`. Use core's `createAuth` for the notice mails | Better Auth sends no mail after a password, passkey, or second-factor change, and has no callback for one |
| `databaseHooks.user` and `databaseHooks.account` map (see "Hooks"). A credential account fires no account hook, and the user delete fires none | Core's password row is not an identity |
| `POST /reauth/email` answers 404 | Better Auth has no re-authentication code |

The passkey rename of `@better-auth/passkey` 1.7.2 is a path of
`auth.handler` and a call of the shim's client: `POST
/passkey/update-passkey` and `passkey.updatePasskey({ id, name })`. Both
call core's `POST /passkeys/rename` and answer `{ passkey }`. The server has
no `auth.api.updatePasskey`, as it has no other passkey call.

| Difference | Why |
| --- | --- |
| The id of another user's passkey answers `PASSKEY_NOT_FOUND` (404), as an unknown id does. Better Auth answers 401 `YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY` | The answer must tell nothing about the passkeys of another user |
| A name has 1 to 64 characters after the trim, with no control or format character except the zero-width joiners. Else `VALIDATION_ERROR` (400) | Core's passkey name rule. A bidi override must not make one passkey read as another |
| The answer's passkey has no `publicKey`, `counter`, `transports`, or `aaguid` | Core keeps them out of its answers |
| `passkey.addPasskey` sends a name that is empty after the trim as no name, so the passkey has the name `null`. Core also stores a name that breaks its rule as `null` | Better Auth keeps an empty name. Core never refuses a new credential for its name |
| 30 renames per user in 15 minutes, then `TOO_MANY_REQUESTS` (429) | Core's limit `passkey-rename:user:<userId>` |

## Client

`createAuthClient` from `better-auth/react` or `better-auth/client` talks to
authtempo's routes under `basePath`. A hand-written `fetch` to a Better Auth
path does not work. consumer-i's invite dialog posts to
`/organization/invite-member`; call `authClient.organization.inviteMember`
instead.

These are every path that Better Auth 1.7.2 defines in `better-auth`
(`dist/api/routes`, the organization and magic link plugins) and in
`@better-auth/passkey` and `@better-auth/expo` (read 2026-10-10 from each
`createAuthEndpoint` call). The handler serves none of them under its Better
Auth request and answer shapes. It answers 404 for each, with two exceptions
that are core's own routes (core `http/routes`, read 2026-10-10): `POST
/sign-out` ends the session, as Better Auth's does, and `/magic-link/verify` is
core's magic link route. With the `magicLink` plugin, a Better Auth-era link
answers `invalid_token`. Without the plugin, it answers 404. The handler
serves `/get-session`, the eleven account paths of plan 12a, and
`/passkey/update-passkey` in Better Auth's shapes, so they are not in this list. See "The session read" and "Account operations". The email code paths are not in
it either (see "Email codes").

- Core: `/account-info`, `/callback/:id`, `/change-password`, `/error`, `/get-access-token`, `/ok`,
  `/refresh-token`, `/request-password-reset`, `/reset-password`,
  `/reset-password/:token`, `/send-verification-email`, `/sign-in/email`,
  `/sign-in/social`, `/sign-out`, `/sign-up/email`, `/update-session`,
  `/verify-email`, `/verify-password`.
- Organization: `/organization/accept-invitation`, `/add-team-member`,
  `/cancel-invitation`, `/check-slug`, `/create`, `/create-role`,
  `/create-team`, `/delete`, `/delete-role`, `/get-active-member`,
  `/get-active-member-role`, `/get-full-organization`, `/get-invitation`,
  `/get-organization`, `/get-role`, `/has-permission`, `/invite-member`,
  `/leave`, `/list`, `/list-invitations`, `/list-members`, `/list-roles`,
  `/list-team-members`, `/list-teams`, `/list-user-invitations`,
  `/list-user-teams`, `/reject-invitation`, `/remove-member`, `/remove-team`,
  `/remove-team-member`, `/set-active`, `/set-active-team`, `/update`,
  `/update-member-role`, `/update-role`, `/update-team` (each under
  `/organization`).
- Magic link: `/sign-in/magic-link`, `/magic-link/verify` (see above).
- Passkey: `/passkey/delete-passkey`, `/passkey/generate-authenticate-options`,
  `/passkey/generate-register-options`, `/passkey/list-user-passkeys`,
  `/passkey/verify-authentication`, `/passkey/verify-registration`.
- Expo: `/expo-authorization-proxy`.

Results keep Better Auth's `{ data, error }` shape. `error.code` is Better
Auth's code from `BETTER_AUTH_CODES`; `error.status` is authtempo's HTTP
status. A password that core's policy refuses answers `PASSWORD_TOO_SHORT`
below the server's `minPasswordLength`, `PASSWORD_TOO_LONG` over 128, and
`INVALID_PASSWORD` otherwise. The server's handler names the case, so the
client and `api` answer the same code.

Since plan 9e the client has Better Auth 1.7.2's email OTP calls, on
core's code routes: `emailOtp.sendVerificationOtp({ email, type })` with
`sign-in` or `forget-password` (the other types answer `NOT_SUPPORTED`),
`signIn.emailOtp({ email, otp })`, `forgetPassword.emailOtp({ email })`,
`emailOtp.requestPasswordReset({ email })`, and
`emailOtp.resetPassword({ email, otp, password })`. `emailOTPClient()` is
accepted in `plugins`. On Expo `signIn.emailOtp` keeps the session token in
`storage`, as `signIn.email` does. The client answers `{ success: true }`
for a malformed address, as core does; only the server's
`/email-otp/send-verification-otp` path answers `INVALID_EMAIL`. Through the
client, every policy refusal of `emailOtp.resetPassword` spends the code,
the length cases too.

An absolute `callbackURL` or `redirectTo` keeps its path only when its origin
is the page's origin, and the server's `authtempo.appURL` must be that
origin, because core lands every sign-in on `appURL`. Any other absolute value
answers `INVALID_CALLBACK_URL` or `INVALID_REDIRECT_URL` with status 403, as
Better Auth's origin check does. A trusted origin that is not `appURL` is
refused too. In React Native there is no page origin, so use a path.

On Expo, `expoClient({ scheme, storagePrefix, storage })` keeps the session
token in `storage` and sends it as the bearer header. `getCookie()` answers
`__Host-tempo_session=<token>`, which the server reads as the session cookie.
The storage key keeps the name of plan 9, `<storagePrefix>_tempo_session`, so
an app update signs no Expo user out.
`signIn.email` and `signUp.email` run in the app. `signIn.social` and
`signIn.magicLink` run in the system browser through authtempo's handoff and
need `webBrowser` (the `expo-web-browser` module) and `crypto` (the
`expo-crypto` module) in `expoClient`; without them they answer `NOT_SUPPORTED`.

`createAuthClient()` with no `baseURL` does not throw when the module loads.
This matters for a Next server render of a client module. The client reads the
base at the first call: `baseURL`, else the page's `location.origin`. A call
with neither answers the error code `BASE_URL_REQUIRED`.

A `baseURL` that is not an absolute `http` or `https` URL (for example
`/api/auth`) throws one error when the client is made. A throw of the Expo
token store's `setItem` answers `UNEXPECTED_RESPONSE` with status 0. The call
does not reject. A `useSession` listener may call `refetch` on every notify.
The store starts no read for a call made while it notifies, so the reads end.
A listener that refetches later (for example in a timer or an effect) on every
notify still reads with no end. Refetch on a change of the data, not on every
notify.
The store is the session store of `@authtempo/client` (plan 11d); this package
maps its state to Better Auth's shape.

`signIn.email` with `rememberMe: false` answers `NOT_SUPPORTED` (501): core
keeps no short session. `rememberMe: true` works.

`fetchOptions.onSuccess` runs once per call, with the last successful
response. A failed sub-request of a call that sends several (for example the
invitation list for a member below admin) never reaches it. The session read
that `inviteMember` and `getFullOrganization` make for the active organization
does not call it.

| Client-only error | `error.code` | `error.status` |
| --- | --- | --- |
| No network answer | `NETWORK_ERROR` | 0 |
| The person cancels a passkey or sign-in prompt | `AUTH_CANCELLED` | 0 |
| The handoff redirect does not match | `INVALID_REDIRECT_URL` | 403 |
| An answer that the client cannot read, or a passkey prompt that fails in the browser | `UNEXPECTED_RESPONSE` | the HTTP status, or 0 for the browser failure |
| A call with no `baseURL` and no page location | `BASE_URL_REQUIRED` | 0 |

Status 0 means that no HTTP response exists. Do not test `status >= 400` alone
for these. The handoff mismatch also has no HTTP response, but it answers 403:
`INVALID_REDIRECT_URL` has one status everywhere, the one in the table below
(plan 9b).

The shim's own codes name the cases that no core code names. The server `api`
throws them as `APIError` with this status, and the client answers them as
`error.code` with this status. `COMPAT_CODES` holds this table, and a test
checks each row here.

| Code | Status | Case |
| --- | --- | --- |
| `INVALID_CALLBACK_URL` | 403 | A `callbackURL` on an origin that is not `appURL` |
| `INVALID_REDIRECT_URL` | 403 | A `redirectTo` on an origin that is not `appURL` |
| `NO_ACTIVE_ORGANIZATION` | 400 | An invitation with no `organizationId` and no active organization |
| `INVITATION_NOT_FOUND` | 404 | `api.cancelInvitation` with an unknown row id |
| `NOT_SUPPORTED` | 501 | An argument or call that core does not serve |
| `BASE_URL_REQUIRED` | 0 | A client call with no `baseURL` and no page location; no request goes out |
| `EMAIL_CAN_NOT_BE_UPDATED` | 400 | `updateUser` with `email` (plan 12a) |
| `FIELD_NOT_ALLOWED` | 400 | `updateUser` with a field other than `name` and `image` (plan 12a) |
| `ACCOUNT_NOT_FOUND` | 400 | `unlinkAccount` with an id that is not the caller's account (plan 12a) |
| `CHANGE_EMAIL_DISABLED` | 400 | `changeEmail` without `user.changeEmail.enabled` (plan 12a) |
| `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` | 405 | `POST /get-session` without `session.deferSessionRefresh` (plan 12a) |
| `PASSKEY_NOT_FOUND` | 404 | `POST /passkey/update-passkey` or `passkey.updatePasskey` with an id that is not a passkey of the caller (plan 12a) |

On Expo, pass `expo-secure-store` as `storage`. The client accepts any object
with `getItem` and `setItem`, as Better Auth does. With a plain store, such as
`localStorage`, the session token lies readable at rest, and any script on the
page can read it.

`twoFactorClient({ twoFactorPage?, onTwoFactorRedirect? })` (plan 9f):
`signIn.email` answers `{ twoFactorRedirect: true, twoFactorMethods: ["totp"]
}` for a user with the factor on and calls `onTwoFactorRedirect`, or sends the
browser to `twoFactorPage`. The client keeps the challenge in memory, so
`twoFactor.verifyTotp({ code })` and `twoFactor.verifyBackupCode({ code })`
work on Expo with no cookie; on the web, after a reload, they send the
`better-auth.two_factor` cookie. On Expo, `trustDevice: true` stores the trust
token under `<storagePrefix>_trust_device`, and the next `signIn.email` sends
it. On Expo, a sign-in that answers a challenge also drops the stored session
token: the token of an earlier sign-in is not the new one. `twoFactor.enable`,
`disable`, `getTotpUri`, and `generateBackupCodes` take the password.
`sendOtp`, `verifyOtp`, and `disableSession: true` answer `NOT_SUPPORTED`. The
answer type holds `twoFactorRedirect` only when the client options name
`twoFactorClient()` in a literal list.

## Plugins

| Plugin | What it does on authtempo |
| --- | --- |
| `organization` | Core's organizations: ranked roles viewer < member < admin < owner, mailed invitations. `sendInvitationEmail` is required. Its `data.id` and `data.invitation.id` hold the invitation token, not the row id: build the accept link from it, and `acceptInvitation({ invitationId })` sends it back. `api.createInvitation` and `api.cancelInvitation` use the row id. |
| `passkey` | Core's passkeys. `rpID`, `rpName`, and `origin` are required; each origin must be `baseURL` or in `trustedOrigins`. |
| `magicLink` | Core's magic link with its confirm page. `sendMagicLink` is required. Without the plugin the magic link paths answer 404. |
| `emailOTP` | Core's email codes (plan 9e): the sign-in code and the reset code. `sendVerificationOTP` is required. It gets `type: "sign-in"` or `type: "forget-password"`, never another type, and a reset code goes only to an address with a user, as in Better Auth. Without the plugin core's code routes answer 404. See "Email codes". |
| `bearer` | Core reads `Authorization: Bearer` on every route already. The plugin adds `set-auth-token` to every response that sets the session cookie. |
| `expo` | Core's handoff for the system browser. `trustedOrigins` must hold the app scheme, for example `reception://`. `expo-origin` becomes `origin` when a request has none. On Expo, `signIn.social` and `signIn.magicLink` open core's sign-in page, which lists every method this server serves: the magic link form only with the `magicLink` plugin, the password form with `emailAndPassword`, a social button per provider, and the passkey button with the `passkey` plugin. The provider is not chosen in advance. A config with `expo` and none of these methods is refused at start. |
| `twoFactor` | Core's TOTP second factor (plan 9f) on the password sign-in. Needs `emailAndPassword.enabled`. `/two-factor/enable` (the password) answers `{ method: "totp", totpURI, backupCodes }`; `/two-factor/verify-totp` with the session turns the factor on and ends the other sessions; at the next sign-in core answers a challenge and sets `better-auth.two_factor`, and `verify-totp` or `verify-backup-code` with that cookie opens the session. `trustDevice: true` sets `better-auth.trust_device` for `trustDeviceMaxAge` (whole days, default 30). `disable`, `get-totp-uri`, and `generate-backup-codes` take the password. `send-otp`, `verify-otp`, and `method: "otp"` answer `NOT_SUPPORTED` (501). Pass `accountLockout: { enabled: false }`: core has no account lockout. `user.twoFactorEnabled` comes from core's `ta_second_factor` row; the Better Auth `twoFactor` table is not read. Backup codes are 23 characters (`backupCodeOptions.length` 23 to 32). Core's gate on the magic link, the email code, and social stays off, as in Better Auth; a reset by code of a user with the factor on opens no session on a device that is not trusted (plan 12c). |

| `admin` | Core's operator tools (plan 12f). Needs `organization` and `authtempo.platformOrganization`. See "The admin plugin". |

Give each plugin once. A second entry with the same id is refused at start, because the server reads only the first.

The `captcha` and `have-i-been-pwned` plugins are refused at start, and the refusal names core's option. Core has both checks (plan 12b): the `captcha` option with `@authtempo/captcha-turnstile`, and `password.breachCheck` with `@authtempo/breach-check`. This package does not pass these options to core.

Only `auth.handler` keeps the plugin behavior in this table: the magic link 404, `set-auth-token`, and the `expo-origin` rule. `auth.tempo.handle` serves core's routes directly, without them.

## The admin plugin

Better Auth's `admin` plugin runs on core's operator tools (plan 12f, spec
section 26). Core has no role on a user. A platform operator is a member of
the platform organization with the platform role. Core checks that member at
each call: the platform role, a verified address, a second factor, and a
fresh session. A Better Auth admin with no second factor has no power.

```ts
import { admin, organization } from "better-auth/plugins";

betterAuth({
  // ...
  authtempo: { platformOrganization: "platform" },
  plugins: [organization({ sendInvitationEmail }), admin({ adminRoles: ["admin"] })],
});
```

The options:

| Option | On authtempo |
| --- | --- |
| `authtempo.platformOrganization` | Required with `admin`, refused without it. The slug of the platform organization. The app's `auth.tempo.api.operator.createAdmin` creates it with the first operator (see "Admins from Better Auth"). |
| `adminRoles` | One rank of `viewer`, `member`, `admin`, and `owner`; default `admin`. It is the platform role. A list with two ranks, or a role that is not a rank, is refused. |
| `impersonationSessionDuration` | Seconds, a whole number of minutes from 5 to 240; default 3600. It is core's `operator.impersonation.ttlMinutes`. Core mails the user a notice at each start. |
| `defaultRole` | `"user"` only, Better Auth's default. |
| `allowImpersonatingAdmins` | `false` only: core never lets an operator impersonate a platform operator. |
| `defaultBanReason`, `defaultBanExpiresIn`, `bannedUserMessage`, `adminUserIds`, `schema`, `ac`, `roles` | Refused. Each refusal names spec section 26. |

Seven calls that core does not serve answer `NOT_SUPPORTED` (501) with a
line that names spec section 26. They are `/admin/set-user-password`,
`/admin/remove-user`, `/admin/create-user`, `/admin/update-user`,
`/admin/list-user-sessions`, `/admin/revoke-user-session`, and
`/admin/has-permission`. In place of a password set or a remove, an operator
bans, and the person resets the password or deletes the account.

`/admin/list-users` takes one search. `searchValue` needs `searchField`
`email` (the default) and `searchOperator` `starts_with`: core searches the
start of an address, never a part inside it or the name. `filterField`
`email` or `id` with `filterOperator` `eq` (the default) is an exact search.
Core lists by id ascending, 1 to 100 users per page, with a cursor and no
total. So `sortBy`, `sortDirection: "desc"`, and an `offset` other than 0 are
refused.

`/admin/set-role` takes the platform role, which grants it, or `user`, which
revokes it. Any other role is refused.

Each mapped write that takes a body needs `content-type: application/json`,
as core's operator routes do. A write with another type or with no type
answers 400 `VALIDATION_ERROR` and changes nothing. The stop of an
impersonation takes no body, so it takes any type.

Each mapped call posts core's operator route with the caller's cookie, so
core's guard decides (plan 12f Task 10):

| Call | Core's route | Answer |
| --- | --- | --- |
| `GET /admin/list-users` | `GET /operator/users` or `/operator/users/search` | `{ users, total, limit, offset }` on a first page that ends the list. A page that does not end it answers `{ users, limit, offset, next }`: pass `after=<next>` for the next page. A later page that ends the list answers `{ users, limit, offset }`. |
| `GET /admin/get-user?id=` | `GET /operator/users/get` | The user. |
| `POST /admin/ban-user` | `POST /operator/users/ban` | `{ user }`. `banExpiresIn` is in seconds, from 60 seconds to 3650 days. `{ user, familyEndFailed: true }` when the act ran but the end of the OAuth refresh families failed: call `/admin/revoke-user-sessions` for the user. |
| `POST /admin/unban-user` | `POST /operator/users/unban` | `{ user }`. |
| `POST /admin/set-role` | `POST /operator/users/platform-role` | `{ user }`, with `familyEndFailed: true` as for a ban. |
| `POST /admin/revoke-user-sessions` | `POST /operator/sessions/end-user` | `{ success: true }`. While sessions stay, `{ success: false, more: true, ended }`: call again. |
| `POST /admin/impersonate-user` | `POST /operator/impersonate` | `{ session, user }` of the new session. The session cookie holds its token, and core's actor cookie keeps the operator's token. A bearer caller gets the token in `session.token` and no cookie. |
| `POST /admin/stop-impersonating` | `POST /operator/impersonate/stop` | `{ session, user }` of the operator's own session, which the session cookie holds again. With no actor cookie, or when the operator's session ended, `{ session: null, user: null }`. |

`auth.api` has Better Auth's server calls of these paths: `listUsers`,
`getUser`, `banUser`, `unbanUser`, `setRole`, `revokeUserSessions`,
`impersonateUser`, and `stopImpersonating`. Each takes Better Auth's
`query` or `body` and the caller's `headers`, and runs the steps of its
path. So it answers what the path answers, with dates as `Date` values. A
refusal throws `APIError` with the status and the code of the path. Without
`admin()`, each call throws 404.

Each user in an answer has Better Auth's admin fields. `role` is the
platform role or `user`. `banned`, `banReason`, and `banExpires` show a
ban that holds now. With `twoFactor()`, each user also has
`twoFactorEnabled`, read from core's `ta_second_factor` rows in one read per
answer. An operator cannot act on another platform operator through these
calls. So a ban, an unban, or a `set-role` of `user` on a
platform operator is refused. The revoke of an operator needs the app
(`auth.tempo.api.operator.platformRole.revoke`), because this package takes
no operator secret.

| Core's refusal | Answer |
| --- | --- |
| `operator_required` (the guard, or a target that is a platform operator) | 403 with the code of the path: `YOU_ARE_NOT_ALLOWED_TO_LIST_USERS`, `YOU_ARE_NOT_ALLOWED_TO_GET_USER`, `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS` (ban and unban), `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`, `YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS`, or `YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS`. |
| `impersonation_refused` (the operator, a platform operator, a banned user, or an absent user) | 403 `YOU_CANNOT_IMPERSONATE_ADMINS`. |
| `impersonation_session` (an impersonation session starts another one) | 403 `FORBIDDEN`. |
| `not_found` on a stop (the session impersonates nobody) | 400 with Better Auth's message `You are not impersonating anyone`. |
| `operator_self` | 409 `YOU_CANNOT_BAN_YOURSELF` on a ban, else 409 `FORBIDDEN`. |
| `not_found` | 404 `USER_NOT_FOUND`. |
| `unauthorized` (no session) | 401 `UNAUTHORIZED`. |

With `admin()`, `/get-session` and `auth.api.getSession` give the user
`role`, `banned`, `banReason`, and `banExpires`, as Better Auth does. The
role is the platform role or `user`. A banned user has no session, so
`banned` is `false` there. With `admin()`, the session also has
`impersonatedBy`: the operator's user id in an impersonation session, else
null. With `adminClient()` from `better-auth/client/plugins`,
the client's `getSession` and `useSession` read `/get-session`. So the user
has the same four fields, and `banExpires` is a `Date` or null. Without
`adminClient()`, the client reads core's own session, and its user has no
such field. The client's `admin` calls send the mapped paths with the
client's fetch, headers, and credentials. Each answers `{ data, error }`,
with dates as `Date` values. `impersonateUser` and `stopImpersonating` read the
session again. Each call that core does not serve answers `NOT_SUPPORTED`
with the handler's line, with no request. `checkRolePermission` throws,
because core has no permission statements.

The deviations from Better Auth (ruling 53 of plan 12f):

- `/admin/list-users` answers `total` only on a first page that ends the list. An
  `offset` above 0 is refused, because core pages by a cursor.
- `/admin/revoke-user-sessions` ends one page per call. While sessions
  stay, it answers `{ success: false, more: true, ended }`.
- A `set-role` of `user` on a platform operator is refused with
  `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`. Better Auth lets an admin
  revoke another admin.
- A ban of the caller answers `YOU_CANNOT_BAN_YOURSELF` with status 409.
  Better Auth answers 400.
- `/admin/revoke-user-sessions`, `/admin/unban-user`, and `/admin/set-role`
  on the caller's own user answer 409 `FORBIDDEN` (core's `operator_self`).
  Better Auth has no such check on these three paths. Core lets no operator
  act on the operator's own user.
- An unknown user answers `USER_NOT_FOUND` on every path. Better Auth answers
  `{ success: true }` on `/admin/revoke-user-sessions`. The shim is stricter,
  so a typo in a user id does not look like a revoke that worked.
- `/admin/impersonate-user` answers one code, `YOU_CANNOT_IMPERSONATE_ADMINS`,
  for the operator, a platform operator, a banned user, and an absent user.
  Better Auth answers `USER_NOT_FOUND` for an absent user. Core keeps one
  code, so the answer does not tell a missing user from a protected one.
- `/admin/stop-impersonating` answers `{ session: null, user: null }` when
  no operator session comes back. Better Auth answers 500 there, and its
  impersonation session stays. Core ends the impersonation session first.

On D1, an act reads the user row once after core's route, for `{ user }`.
With `twoFactor()`, it also reads the factor row once.
A ban of a user with 60 sessions sends 35 queries in its invocation.
A ban of a user with 501 sessions sends 49: core ends one page of sessions
in the budget, and the sweep ends the rest.
An impersonation start sends 33 queries and a stop 19, each with the
shim's read of the session for `{ session, user }`.

Better Auth requires a reason nowhere, and core writes an audit row with a
reason for each act. A ban takes `banReason` as its reason. Every other call,
and a ban with no `banReason`, writes `better-auth admin plugin <path>`. Then
the audit row holds no human reason.

### Bans from Better Auth

Core reads a ban from its own columns `taBannedAt`, `taBanReason`, and
`taBanUntil`, never from Better Auth's `banned`. Compat migration 0009 adds
these columns and copies each ban of the admin plugin into them, in the
same run. It copies `banReason` and `banExpires` for each user whose
`banned` is true. Better Auth keeps no ban time, so `taBannedAt` takes the
row's `updatedAt`. A ban whose `banExpires` passed stays ended.

The copy reads the admin plugin's columns only where they exist, so an app
without the plugin runs the same file. A row that has `taBannedAt` is
skipped, so a second run of the copy changes nothing. The columns take the
app's naming (`columns.user.banned`, `banReason`, and `banExpires`), as
`compatMigration0009Sql` writes them.

### Admins from Better Auth

Core gives operator power by the platform role only, never by Better
Auth's `role` column. Do these steps at the cutover for each user whose
`role` names the rank of `adminRoles`. Skip them, and each such admin loses
the admin power: each admin call answers 403.

1. Make one admin the first operator, once, in the app:
   `auth.tempo.api.operator.createAdmin({ actor, email, reason, ip: null, userAgent: null })`.
   It makes the platform organization.
2. Grant the platform role to each other admin with
   `auth.tempo.api.operator.platformRole.grant`, or with `/admin/set-role`
   from the first operator's session.
3. Ask each admin to sign in again and turn a second factor on. A session
   from before the grant holds no operator power. The guard also needs a
   verified address and a fresh session.

The `authtempo` option takes no operator secret, so the CLI's
`create-admin` and `users` commands do not reach this app.

## Email codes

`emailOTP({ sendVerificationOTP, … })` maps onto core's `emailOtp` (plan 9e).

- `otpLength` is 6 or 8. `allowedAttempts` is 3 to 10; without it the cap
  is 3, Better Auth's default. Core answers `TOO_MANY_ATTEMPTS` at the
  allowed-th wrong code, and Better Auth at the next try; both compare the
  same number of codes.
- `expiresIn` is 60 to 3600 seconds, rounded up to whole minutes:
  `expiresIn: 90` lives 2 minutes. Without it a code lives 5 minutes,
  Better Auth's default.
- `storeOTP` is `hashed` or absent. Core stores HMAC-SHA256 under the app
  secret of the row id and the code either way. `plain`, `encrypted`, and an
  object are refused.
- `disableSignUp` follows the one sign-up rule (see "Secrets and sign-up").
- `changeEmail: { enabled: true }` serves the change of address by code
  (plan 12a). `verifyCurrentEmail: true` is refused: core proves the new
  address only.
- Refused by name: `generateOTP`,
  `overrideDefaultEmailVerification: true`, `sendVerificationOnSignUp: true`,
  `resendStrategy: "reuse"`, and `rateLimit`.

`auth.handler` serves these Better Auth paths in Better Auth's shapes,
because apps post them by hand. An error answers `{ code, message }` with
authtempo's status.

| Path | Body | Answer |
| --- | --- | --- |
| `/email-otp/send-verification-otp` | `{ email, type }` | `{ success: true }` for `sign-in` and `forget-password`; 400 `INVALID_EMAIL` for a malformed address, as Better Auth does; 501 `NOT_SUPPORTED` for `email-verification` and `change-email` |
| `/sign-in/email-otp` | `{ email, otp }` | `{ token, user }` with the session cookie; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`; 501 `NOT_SUPPORTED` for `name`, `image`, or another user field |
| `/forget-password/email-otp`, `/email-otp/request-password-reset` | `{ email }` | `{ success: true }` |
| `/email-otp/request-email-change` | `{ newEmail }` | With `changeEmail.enabled`: `{ success: true }`. The code goes to the new address with the type `change-email`. A taken address gets no code, as in Better Auth. A stale session answers 403 `SESSION_NOT_FRESH` |
| `/email-otp/change-email` | `{ newEmail, otp }` | With `changeEmail.enabled`: `{ success: true }`, and the address moves; 400 `INVALID_OTP` for a wrong code or a `newEmail` that differs from the request |
| `/email-otp/reset-password` | `{ email, otp, password }` | `{ success: true }` with the session cookie of the new session; for a user with the second factor on, `{ success: true }` with no cookie unless the device is trusted, as Better Auth answers every reset, and the next sign-in asks for the factor (plan 12c); 400 `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` before the code check, so the code stays usable, as in Better Auth; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`, `INVALID_PASSWORD`, `PASSWORD_COMPROMISED` |

`/email-otp/verify-email` and `/email-otp/check-verification-otp` answer 501
`NOT_SUPPORTED`, and so do the two change paths without `changeEmail.enabled`. A wrong, expired, or spent code answers `INVALID_OTP`:
core does not tell expiry from a wrong code, so `OTP_EXPIRED` never
appears. Better Auth answers `TOO_MANY_ATTEMPTS` with 403; authtempo with
400. A password that the policy refuses for another reason than its length
spends the code: request a new one.

## Hooks

The package maps Better Auth's hooks onto core's hooks (plan 9d; the core
README, "Hooks").

- `organization({ organizationHooks })` takes Better Auth 1.7.2's names:
  `beforeCreateOrganization`, `afterCreateOrganization`,
  `beforeUpdateOrganization`, `afterUpdateOrganization`,
  `beforeDeleteOrganization`, `afterDeleteOrganization`, `beforeAddMember`,
  `afterAddMember`, `beforeRemoveMember`, `afterRemoveMember`,
  `beforeUpdateMemberRole`, `afterUpdateMemberRole`,
  `beforeCreateInvitation`, `afterCreateInvitation`,
  `beforeAcceptInvitation`, `afterAcceptInvitation`, `afterRejectInvitation`,
  and `afterCancelInvitation`. Each hook gets Better Auth's argument keys.
  The team hooks, `beforeCancelInvitation`, and `beforeRejectInvitation` are
  refused at start.
- A before hook runs inside core's transaction.
  `throw new APIError("FORBIDDEN", { message })` answers 403 `HOOK_REFUSED`
  with that message, on the server `api` and on the client. Any other throw
  answers 500 `HOOK_FAILED`. No row is written. The status of the
  `APIError` is not kept: every thrown `APIError` answers 403
  `HOOK_REFUSED`, also `new APIError("BAD_REQUEST")`.
- On Postgres, do not query the client that core's adapter uses from a
  before hook while its pool has one connection (`max: 1`, the setup the
  adapter README gives for Workers). The transaction holds that one
  connection and waits for the hook, and the hook's query waits for the
  connection: the request hangs until the pool times out. A before hook
  that writes the app's own row uses a second connection (a pool of two or
  more, or a separate client), or the app writes from the after hook and
  accepts that a failed write leaves the core row without it. On D1, a
  write through the binding is a separate request and takes no lock.
- An after hook runs after the commit. A throw is logged with the hook name
  and the row id, and the call answers success. In Better Auth the same
  throw answers an error for a row that exists.
- A before hook cannot change the row. A `{ data }` answer that changes a
  field it was given stops the write with `HOOK_FAILED` and one log line.
  The compare is by `Object.is`, so an object field compares by reference:
  a new copy of `metadata` with the same content counts as a change.
  `beforeCreateOrganization` gets `organization.id`, the id core writes: an
  app that keeps its own row writes it with this id and returns nothing.
- `beforeAcceptInvitation` runs on every accept. `beforeAddMember` and
  `afterAddMember` run for the creator's row and for an add, not for an
  accept, as in Better Auth. `beforeRemoveMember` and `afterRemoveMember`
  run on a leave too; Better Auth 1.7.2 runs neither there.
  `afterAcceptInvitation` runs on every successful accept, whether the
  accept created the member row or found it, as in Better Auth 1.7.2.
  An accept that raises an existing member's role runs
  `beforeUpdateMemberRole` and `afterUpdateMemberRole` too, with the
  inviter as the caller. A refusal keeps the role and the invitation
  pending. Better Auth 1.7.2 refuses to invite an existing member, so
  there the role hooks see every role change; core keeps that promise.
  `afterRejectInvitation` gets `user: null` when the decline request
  carried no session.
- `databaseHooks.session.create.before` gets `{ userId, ipAddress,
  userAgent, activeOrganizationId }`. Its `{ data }` may change `ipAddress`,
  `userAgent`, and `activeOrganizationId`. The organization must be one the
  user is a member of, or the sign-in answers `NOT_FOUND`. A change of
  another field is dropped, with one log line at the first call. `false`
  answers `HOOK_REFUSED`. `databaseHooks.session.create.after` gets the
  stored session; its `token` holds the token's SHA-256 hex, as the
  `session.token` column does.
- `databaseHooks.user` (plan 12a): `create.before` gets the new user, and
  its `{ data }` may set `name` and `image`. A change of another field is
  dropped, with one log line at the first call. `update.before` gets the
  changed fields; a `{ data }` answer is dropped with one log line, because
  core's update hooks change no row. `false` refuses each before hook with
  `HOOK_REFUSED`. The delete runs `user.deleteUser.beforeDelete`, then
  `delete.before`. After the commit it runs `delete.after`, then
  `user.deleteUser.afterDelete`, in Better Auth 1.7.2's order. The
  `request` argument of `beforeDelete` and `afterDelete` is undefined.
- `emailVerification.beforeEmailVerification` and `afterEmailVerification`
  (plan 12a) map to core's `user.beforeVerify` and `user.afterVerify`. Each
  gets Better Auth's user shape, and the `request` argument is undefined.
  Core calls them on each path that proves the address of an unverified
  user. These paths are the verify link, the magic link, the email code, the
  reset, and a social sign-in with a verified provider address. Better Auth
  1.7.2 calls them at its verify link (`email-verification.mjs:294` and
  `:296`) and at `/email-otp/verify-email` (`routes.mjs:327` and `:332`).
  The shim answers that path `NOT_SUPPORTED`. Better Auth also calls them at
  a change of address, and so does the shim. The change link calls the after
  hook only (`email-verification.mjs:229`). `/email-otp/change-email` calls
  both (`routes.mjs:736` and `:741`). The after hook gets the moved user,
  after core's commit. One timing differs: Better Auth calls the before hook
  of the change by code after its code check. The shim calls it before
  core's route, so a wrong code still calls it. A thrown `APIError` in a
  before hook answers `HOOK_REFUSED`, and nothing changes. A throw in an
  after hook writes one log line, and the answer stands. Better Auth answers
  that error to the caller.
- `databaseHooks.account` (plan 12a): `create` runs at a provider link, and
  `delete` at an unlink. Each gets `{ providerId, accountId, userId }`, with
  no row id. A credential account fires none, because core's password row is
  not an identity. The user delete fires no account hook, where Better Auth
  runs the account delete hooks for each account of the user.
- Every other `databaseHooks` key is refused.
- `organizationLimit` as a number, `membershipLimit`, and `invitationLimit`
  map onto core's `organizations.limits`. With the option absent,
  `membershipLimit` and `invitationLimit` are 100, Better Auth's defaults. A
  function `organizationLimit` runs before `beforeCreateOrganization`, and a
  true answer refuses with "You have reached the maximum number of
  organizations". A function `membershipLimit` or `invitationLimit` is
  refused. The number limits answer 409, not Better Auth's 403. The
  function `organizationLimit` answers 403 `HOOK_REFUSED` with that text,
  because it runs as a before hook.
- Hooks have no timeout. A hook that never settles holds the request.

### Request hooks

Core has no request hooks, so `hooks` is refused. Wrap the handler, and
read the session from `auth.tempo.session(request)`. Do not use
`auth.tempo.caller(request)` here: it also answers for an API token. The
read can move the session expiry forward. Send the renewed cookie from
`auth.tempo.sessionCookie(request, session)` on the response when it is not
null, or the browser drops the cookie at its old Max-Age. consumerd's two
uses, as a wrapper:

```ts
const auth = betterAuth(options);

/** consumerd's hooks.before (admin-only organization reads) and hooks.after (an audit row). */
export async function handler(request: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  if (
    pathname === "/api/auth/organizations/members" ||
    pathname === "/api/auth/organizations/invitations"
  ) {
    const session = await auth.tempo.session(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    const list = await auth.tempo.api.listOrganizations({ user: session.user });
    const id = searchParams.get("organizationId");
    const role = list.ok ? list.value.find((x) => x.organization.id === id)?.role : undefined;
    if (role !== "admin" && role !== "owner")
      return Response.json({ error: "forbidden_rank" }, { status: 403 });
    return withCookie(await auth.handler(request), auth.tempo.sessionCookie(request, session));
  }
  const response = await auth.handler(request);
  if (pathname === "/api/auth/organizations/members/remove" && response.ok) {
    const session = await auth.tempo.session(request);
    if (session) {
      await recordMemberChange(session.user.id);
      return withCookie(response, auth.tempo.sessionCookie(request, session));
    }
  }
  return response;
}

/** The response with the renewed session cookie appended, when there is one. */
function withCookie(response: Response, cookie: string | null): Response {
  if (cookie === null) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}
```

The guard on `/organizations/members` also answers 403 to
`authClient.organization.getFullOrganization` for a plain member, because
that call lists the members. To let a plain member open the organization,
guard only `/organizations/invitations`.

The audit row of a leave is simpler as `organizationHooks.afterRemoveMember`,
which runs on a leave.

## The five Better Auth apps

None of the five runs with no edit. These are the edits, and the refusals the
factory prints without them.

consumere (small edits):
- Remove `secondaryStorage` and `session.storeSessionInDatabase: false`. Sessions move into a `session` table. Create it, and the `organization`, `member`, `invitation`, and `passkey` tables, with Better Auth's own SQL before migration 0001.
- `databaseHooks.session.create.before` runs unchanged since plan 9d: core stores the `userAgent: null` it answers. To store no IP, keep `advanced.ipAddress.disableIpTracking: true`; the factory logs a note. For a request with no client IP, only the password sign-in, the magic link, the reset request, and the verify mail resend skip the per-IP limit and keep the per-email limit. Every other flow keeps core's shared bucket.
- The `socialProviders` config of GitHub and LinkedIn runs unchanged since plan 9c, and the redirect URI at each provider changes (see the cutover list). Their Better Auth-era accounts sign in to the same users.
- Run Drizzle on postgres.js (`drizzle-orm/postgres-js`), not on Neon's driver.
- `sendVerificationEmail` with a `callbackURL` answers NOT_SUPPORTED; leave the `callbackURL` out.

consumer-i (small edits):
- Add `emailAndPassword.sendResetPassword` and `emailVerification.sendVerificationEmail`, and `sendInvitationEmail` in `organization()`.
- Remove `rateLimit.window`, `max`, `customStorage`, and `customRules`. Core's owned limiter in `ta_limit` replaces them, with its own fixed limits per flow.
- `organizationLimit: 5` and `organizationHooks.afterCreateOrganization` run unchanged since plan 9d. A throw in the hook no longer answers an error for an organization that exists: core logs it and answers success. To keep no organization without its tenant row, write the row in `beforeCreateOrganization` with `organization.id`. On Postgres with `max: 1`, write it on a second connection (see "Hooks"), or the request hangs.
- The invite dialog posts to `/api/auth/organization/invite-member` by hand. Call `authClient.organization.inviteMember` instead.
- Add the `passkey` table. Migration 0001 adds and fills `account.issuer` on Postgres (consumer-i's tables are from before Better Auth 1.7).

consumerc (follow-ups first): `hooks` (the leave guard of `leave.ts` moves into `organizationHooks.beforeRemoveMember`, which core runs on a leave); `beforeCreateOrganization` writes the studio with `organization.id` and returns nothing, because a `{ data }` that changes the id stops the write (on Postgres with `max: 1`, on a second connection; see "Hooks"); custom roles, `ac`, and dynamic access control; the Apple config as `teamId`, `keyId`, `privateKey`; the session-end paths in `session-end.ts` (or `databaseHooks.session.create.after` and core's `afterEnd`); the `getSchema()` test; `advanced.ipAddress.ipAddressHeaders` (or `disableIpTracking: true`) before `toNodeHandler` or `toNextJsHandler` accepts the instance.
The factory refuses exactly these: `hooks`, `plugins[expo]`, `plugins[organization].ac`, `plugins[organization].dynamicAccessControl`, `plugins[organization].roles`, `plugins[organization].sendInvitationEmail`, `socialProviders.apple.clientSecret`, `socialProviders.apple`.

consumerd (follow-ups first): `authtempo.platformOrganization` for the admin plugin (see "The admin plugin"), anonymous sign-in, teams, `hooks` (wrap the handler; see "Request hooks"), `$context` and `getOrgAdapter`, the rate limit storage. `freshAge: 600` and `deferSessionRefresh: true` run unchanged since plan 12a: core's window is 10 minutes, and the shim's client posts the deferred refresh. `membershipLimit: 50` and `organizationLimit: 3` run unchanged since plan 9d. The `emailOTP` options (`otpLength: 6`, `expiresIn: 600`, `allowedAttempts: 5`, `storeOTP: "hashed"`) run unchanged since plan 9e, and the tests that post `/email-otp/send-verification-otp` and `/sign-in/email-otp` keep their paths. The test that reads the verification row by `sign-in-otp-<email>` reads `identifier = <email>` and `"taPurpose" = 'email-otp'` instead. With snake-case names, the column is `ta_purpose`. The row holds a keyed hash, never the code.
The factory refuses exactly these: `baseURL`, `hooks`, `plugins[admin]`, `plugins[anonymous]`, `plugins[organization].ac`, `plugins[organization].disableOrganizationDeletion`, `plugins[organization].roles`, `plugins[organization].teams`, `plugins[passkey].origin`, `rateLimit.customStorage`, `secret`.

consumerb (follow-ups first): API keys (the api-key mapping, a later plan; see the plan index), the OAuth 2.1 provider through `mcp` and `cimd`, and `jwt` and JWKS (refused since plan 9g; see "JWT and the OAuth provider"), `authtempo.platformOrganization` for the admin plugin (see "The admin plugin"), `defaultCookieAttributes.secure`, the `.well-known` routes; `advanced.ipAddress.ipAddressHeaders` (or `disableIpTracking: true`) before `toNodeHandler` or `toNextJsHandler` accepts the instance.
The factory refuses exactly these: `advanced.defaultCookieAttributes.secure`, `emailAndPassword.sendResetPassword`, `emailVerification.expiresIn`, `plugins[admin]`, `plugins[api-key]`, `plugins[cimd]`, `plugins[jwt]`, `plugins[mcp]`, `plugins[organization].ac`, `plugins[organization].roles`, `plugins[organization].sendInvitationEmail`, `plugins[passkey].origin`.

## JWT and the OAuth provider

Since plan 9g, core mints JWTs (`/jwks`, `/token`, `api.jwt`) and is an OAuth 2.1 and OIDC provider (`/oauth/*` and `auth.wellKnown`). This package maps none of the Better Auth plugins for them (owner decision of 2026-10-13): `jwt`, `mcp`, `cimd`, `oidc-provider`, and `oauth-provider` are refused at construction, and core's minting is off under the package (`jwtMint: false`), so `/api/auth/jwks` and `/api/auth/token` answer 404.

- To keep the provider, move the app from this package to core's own `createAuth` with `jwtMint` and `oauth`, and mount `auth.wellKnown` at the origin root. Migration 0004 already holds core's four tables.
- The Better Auth `jwks` table (`id`, `publicKey`, `privateKey`, `createdAt`, `expiresAt`, `alg`, `crv` in 1.7.2) is neither read nor written. A JWT that Better Auth issued stops verifying at the cutover, and each OAuth client signs in again: its Better Auth refresh tokens and consents do not carry over.
