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
- The session cookie is `tempo_session`, not `better-auth.session_token`. App code, tests, and legal pages that name the old cookie must change. For example, consumer-i's site lists `__Secure-better-auth.session_token` in its cookie text (`apps/site/test/legal.test.ts`).
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
- Every app: then copy each later file of the same directory (`0002_compat_schema_v5.sql` to `0005_compat_schema_v8.sql`), in order, and give each the next number.
- Tables with other names: write the file from `storage.migrationSql()` or `storage.migrationSql("before-1.7")`.

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
| The client IP comes from `x-forwarded-for` | It comes from `cf-connecting-ip`. Set `advanced.ipAddress.ipAddressHeaders` off Workers: off Workers any caller sets `cf-connecting-ip`, so every per-IP limit can be rotated. `toNodeHandler` and `toNextJsHandler` throw `BetterAuthCompatError` at creation for an instance with neither a non-empty `ipAddressHeaders` nor `disableIpTracking: true`. A listed header value that is not an IPv4 or IPv6 literal counts as no client IP. A request with no client IP (a server call with no headers, or every request under `disableIpTracking: true`, which logs a note) skips the per-IP limit only for password sign-in, the magic link, the reset request, and the verify mail resend, which keep their per-email limits. Every other flow (sign-up, the reset form, invitation accept, the handoff, passkeys, social start) has only a per-IP limit, so it counts all such requests in one shared bucket. |
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
sign-in through the handler.

An invitation has two ids. The mail id (`data.id` in `sendInvitationEmail`)
accepts the invitation, and the row id (from `api.createInvitation`) cancels it.

`api.sendVerificationEmail` and `authClient.sendVerificationEmail` send a new
verify link through core's resend route (plan 8b). The earlier link of the
address stops working. A `callbackURL` answers `NOT_SUPPORTED` (501): core lands
the link on the app origin.

Errors: `APIError` on the server and `error` on the client carry Better Auth's
code (`body.code`, `error.code`) and core's HTTP status. The table is
`BETTER_AUTH_CODES`.

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
answers `invalid_token`. Without the plugin, it answers 404.

- Core: `/account-info`, `/callback/:id`, `/change-email`, `/change-password`,
  `/delete-user`, `/delete-user/callback`, `/error`, `/get-access-token`,
  `/get-session`, `/link-social`, `/list-accounts`, `/list-sessions`, `/ok`,
  `/refresh-token`, `/request-password-reset`, `/reset-password`,
  `/reset-password/:token`, `/revoke-other-sessions`, `/revoke-session`,
  `/revoke-sessions`, `/send-verification-email`, `/sign-in/email`,
  `/sign-in/social`, `/sign-out`, `/sign-up/email`, `/unlink-account`,
  `/update-session`, `/update-user`, `/verify-email`, `/verify-password`.
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
  `/passkey/update-passkey`, `/passkey/verify-authentication`,
  `/passkey/verify-registration`.
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
`tempo_session=<token>`, which the server reads as the session cookie.
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
| `twoFactor` | Core's TOTP second factor (plan 9f) on the password sign-in. Needs `emailAndPassword.enabled`. `/two-factor/enable` (the password) answers `{ method: "totp", totpURI, backupCodes }`; `/two-factor/verify-totp` with the session turns the factor on and ends the other sessions; at the next sign-in core answers a challenge and sets `better-auth.two_factor`, and `verify-totp` or `verify-backup-code` with that cookie opens the session. `trustDevice: true` sets `better-auth.trust_device` for `trustDeviceMaxAge` (whole days, default 30). `disable`, `get-totp-uri`, and `generate-backup-codes` take the password. `send-otp`, `verify-otp`, and `method: "otp"` answer `NOT_SUPPORTED` (501). Pass `accountLockout: { enabled: false }`: core has no account lockout. `user.twoFactorEnabled` comes from core's `ta_totp` row; the Better Auth `twoFactor` table is not read. |

Give each plugin once. A second entry with the same id is refused at start, because the server reads only the first.

Only `auth.handler` keeps the plugin behavior in this table: the magic link 404, `set-auth-token`, and the `expo-origin` rule. `auth.tempo.handle` serves core's routes directly, without them.

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
- Refused by name: `generateOTP`, `disableSignUp: true`,
  `overrideDefaultEmailVerification: true`, `sendVerificationOnSignUp: true`,
  `resendStrategy: "reuse"`, `changeEmail`, and `rateLimit`.

`auth.handler` serves these Better Auth paths in Better Auth's shapes. They
are the one set of Better Auth paths that the handler serves in Better
Auth's shapes, because apps post them by hand. An error answers `{ code,
message }` with authtempo's status.

| Path | Body | Answer |
| --- | --- | --- |
| `/email-otp/send-verification-otp` | `{ email, type }` | `{ success: true }` for `sign-in` and `forget-password`; 400 `INVALID_EMAIL` for a malformed address, as Better Auth does; 501 `NOT_SUPPORTED` for `email-verification` and `change-email` |
| `/sign-in/email-otp` | `{ email, otp }` | `{ token, user }` with the session cookie; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`; 501 `NOT_SUPPORTED` for `name`, `image`, or another user field |
| `/forget-password/email-otp`, `/email-otp/request-password-reset` | `{ email }` | `{ success: true }` |
| `/email-otp/reset-password` | `{ email, otp, password }` | `{ success: true }` with the session cookie of the new session; 400 `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` before the code check, so the code stays usable, as in Better Auth; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`, `INVALID_PASSWORD`, `PASSWORD_COMPROMISED` |

`/email-otp/verify-email`, `/email-otp/check-verification-otp`,
`/email-otp/request-email-change`, and `/email-otp/change-email` answer 501
`NOT_SUPPORTED`. A wrong, expired, or spent code answers `INVALID_OTP`:
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
  `session.token` column does. Every other `databaseHooks` key is refused.
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

consumerd (follow-ups first): admin and impersonation, anonymous sign-in, teams, `hooks` (wrap the handler; see "Request hooks"), `$context` and `getOrgAdapter`, `freshAge`, `deferSessionRefresh`, the rate limit storage. `membershipLimit: 50` and `organizationLimit: 3` run unchanged since plan 9d. The `emailOTP` options (`otpLength: 6`, `expiresIn: 600`, `allowedAttempts: 5`, `storeOTP: "hashed"`) run unchanged since plan 9e, and the tests that post `/email-otp/send-verification-otp` and `/sign-in/email-otp` keep their paths. The test that reads the verification row by `sign-in-otp-<email>` reads `identifier = <email>` and `"taPurpose" = 'email-otp'` (`ta_purpose` with snake-case names) instead; the row holds a keyed hash, never the code.
The factory refuses exactly these: `baseURL`, `hooks`, `plugins[admin]`, `plugins[anonymous]`, `plugins[organization].ac`, `plugins[organization].disableOrganizationDeletion`, `plugins[organization].roles`, `plugins[organization].teams`, `plugins[passkey].origin`, `rateLimit.customStorage`, `secret`, `session.deferSessionRefresh`, `session.freshAge`.

consumerb (follow-ups first): API keys (the api-key mapping, a later plan; see the plan index), the OAuth 2.1 provider through `mcp` and `cimd`, and `jwt` and JWKS (refused since plan 9g; see "JWT and the OAuth provider"), admin, `requireEmailVerification`, `defaultCookieAttributes.secure`, the `.well-known` routes; `advanced.ipAddress.ipAddressHeaders` (or `disableIpTracking: true`) before `toNodeHandler` or `toNextJsHandler` accepts the instance.
The factory refuses exactly these: `advanced.defaultCookieAttributes.secure`, `emailAndPassword.requireEmailVerification`, `emailAndPassword.sendResetPassword`, `emailVerification.expiresIn`, `plugins[admin]`, `plugins[api-key]`, `plugins[cimd]`, `plugins[jwt]`, `plugins[mcp]`, `plugins[organization].ac`, `plugins[organization].roles`, `plugins[organization].sendInvitationEmail`, `plugins[passkey].origin`.

## JWT and the OAuth provider

Since plan 9g, core mints JWTs (`/jwks`, `/token`, `api.jwt`) and is an OAuth 2.1 and OIDC provider (`/oauth/*` and `auth.wellKnown`). This package maps none of the Better Auth plugins for them (owner decision of 2026-10-13): `jwt`, `mcp`, `cimd`, `oidc-provider`, and `oauth-provider` are refused at construction, and core's minting is off under the package (`jwtMint: false`), so `/api/auth/jwks` and `/api/auth/token` answer 404.

- To keep the provider, move the app from this package to core's own `createAuth` with `jwtMint` and `oauth`, and mount `auth.wellKnown` at the origin root. Migration 0004 already holds core's four tables.
- The Better Auth `jwks` table (`id`, `publicKey`, `privateKey`, `createdAt`, `expiresAt`, `alg`, `crv` in 1.7.2) is neither read nor written. A JWT that Better Auth issued stops verifying at the cutover, and each OAuth client signs in again: its Better Auth refresh tokens and consents do not carry over.
