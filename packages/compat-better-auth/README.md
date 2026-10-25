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
    "@better-auth/api-key": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/sso": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/scim": "npm:@authtempo/compat-better-auth@0.0.0",
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
example `@better-auth/stripe`, stays the real package, and `betterAuth`
refuses its plugin by id at construction.

| Import in the app | Answered by |
| --- | --- |
| `better-auth` | `.` |
| `better-auth/plugins` | `./plugins` |
| `better-auth/plugins/access` | `./plugins/access` (`createAccessControl`, `role`) |
| `better-auth/plugins/organization/access` | `./plugins/organization/access` (`defaultStatements`, `defaultAc`, `ownerAc`, `adminAc`, `memberAc`, `defaultRoles`) |
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
| `@better-auth/api-key` | `./api-key` (`apiKey`, plan 12k) |
| `@better-auth/api-key/client` | `./api-key/client` (`apiKeyClient`, plan 12k) |
| `@better-auth/sso` | `.` (`sso`, plan 12d) |
| `@better-auth/sso/client` | `./client` (`ssoClient`, plan 12d) |
| `@better-auth/scim` | `.` (`scim`, plan 12d) |

`better-auth/api` maps to `./api`, which exports `APIError` only (plan 9b).
An import of another name from it, such as `createAuthMiddleware`, fails at
build: core has no request hooks (plan 9d). Wrap the handler instead (see
"Request hooks").

The package exports no other subpath. An import of `better-auth/db` or
`better-auth/types` fails at build. consumerc imports `better-auth/db` and
consumerb imports `better-auth/types`: remove those imports first.

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

Plan 12k: core's token routes work in the shim. Migration 0010 creates core's own `ta_api_token`, `ta_organization_token`, and `ta_moved_token`, the record of each moved key. So `/tokens`, `/organizations/tokens`, and `tempo.api.tokens.*` act on this storage (see "API keys").

What changes at cutover:

- The `session.token` column holds the SHA-256 hex of the token, never the raw token. Better Auth-era sessions end: every person signs in again once. App SQL that reads `session.token` reads a hash.
- Better Auth-era verification rows and invitations stay in the table and core never reads them. Send pending invitations again.
- Users, Google, Apple, GitHub, LinkedIn, TikTok, WeChat, Microsoft, Discord, GitLab, X (`twitter`), and Facebook accounts, credential passwords, organizations, members, and passkeys carry over. A password rehashes to PBKDF2 at its first sign-in.
- The `ta_meta` and `ta_limit` tables go in the first schema of the search path, also when the Better Auth tables sit in another schema.
- A passkey counter above 2147483647 fails: Better Auth's `counter` column is `integer`.
- The session cookie is `__Host-tempo_session`, not `better-auth.session_token`. For one release the shim also reads `tempo_session`, the name of plan 9, and moves it: the handler sets `__Host-tempo_session` with the same token and clears `tempo_session`. `api.getSession` reads the old name too, but sets no cookie. App code, tests, and legal pages that name the old cookie must change. For example, consumer-i's site lists `__Secure-better-auth.session_token` in its cookie text (`apps/site/test/legal.test.ts`).
- `socialProviders.microsoft` (`clientId`, `clientSecret`, `tenantId`, default `common`), `discord`, `gitlab` (with `issuer`), `twitter`, and `facebook` map to core's presets (plan 12i Task 16). Each preset keeps the subject that Better Auth stored as `accountId`, so the rows link on the first sign-in. Every other key of these providers is refused.
- Core trusts fewer provider addresses than Better Auth. A Microsoft address is verified only with the `xms_edov: true` claim, and Better Auth also counts `email_verified` and the `verified_*_email` lists. A GitLab address is never verified in core, and Better Auth counts `email_verified`. Take a person whose account has a password, at a first Microsoft or GitLab sign-in. Better Auth links by the address, and core answers `email_taken_unverified`. Rows that Better Auth linked before keep linking by subject.
- Better Auth-era `account` rows of providers that the package does not map stay in the table. Core reads them as identities of their users, so a claim of the address deletes them as it deletes any identity other than the proving one. The factory refuses such a provider in `socialProviders`, and the reason depends on the provider id:
  - `slack`: refused. Core's Slack subject is `<team_id>:<user_id>`, and a Better Auth Slack row holds the user id alone (ruling 22 of plan 12i). The row would not link at the first sign-in, and the person would get a second account, or `email_taken` for a verified address. Before you use core's `social.slack` through core's `createAuth`, rewrite each Slack `accountId` to `<team_id>:<user_id>`. The refusal text starts with `not mapped: core's Slack subject is team_id:user_id`.
  - Any other id: `not mapped; add it through core's social.oidc or social.oauth2`. On core's `createAuth`, a list entry whose `name` is the Better Auth provider id and whose subject is the id that Better Auth stored as `accountId` links these rows on the first sign-in.

  A compat app that needs such a provider uses core's `createAuth`, because `betterAuth()` takes no preset or list entry outside the ones it maps.
- The callback stays Better Auth's: `<baseURL><basePath>/callback/<provider>`. On an https `baseURL`, the shim gives each provider that URI as core's `redirectURI` override (plan 12i Task 16), so nothing changes at the provider. A provider's own `redirectURI` option wins, and core checks that it has the origin of `baseURL`. Core takes an override on https only: on an http `baseURL` (local work), register `<baseURL><basePath>/social/<provider>/callback`.
- GitHub and LinkedIn accounts link on the first sign-in by the id Better Auth stored: the numeric GitHub id, and LinkedIn's OpenID `sub`. LinkedIn's `sub` stays the same only while the client id stays the same.
- `socialProviders.tiktok` (`clientKey`, `clientSecret`) and `socialProviders.wechat` (`clientId`, `clientSecret`) map to core's `tiktokEntry` and `wechatEntry` (plan 12i Task 22). Their accounts link by the id Better Auth stored: the TikTok `open_id`, and the WeChat `unionid`, else `openid`. The two entries have no address, so core keeps the placeholder address of a Better Auth-era user unverified and never links by it. WeChat's `lang` and `platformType` are refused. The TikTok callback stays Better Auth's (see above), and the API host stays the WeChat callback domain. The storage reads Better Auth's TikTok and WeChat placeholders (`<id>@tiktok.placeholder.invalid`) as no address, so they never count as proved (see "Sign-in plugins").
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
- Every app: then copy each later file of the same directory (`0002_compat_schema_v5.sql` to `0012_compat_schema_v15.sql`), in order, and give each the next number.
- Tables with other names: write the 0001 file from `storage.migrationSql()` or `storage.migrationSql("before-1.7")`. Write the 0006 file from `compatMigration0006Sql("sqlite", storage.names)`, not from the shipped file. The shipped 0006 adds `taSecretVersion` to Better Auth's default `verification` table, so on other names it fails with `no such table`. Write the 0007 file from `compatMigration0007Sql("sqlite", storage.names)` for the same reason: the shipped 0007 adds `taFreshAt` to the default `session` table. Write the 0009 file from `compatMigration0009Sql("sqlite", storage.names)` for the same reason. The shipped 0009 adds the ban columns to the default `user` table and `taActorId` to the default `session` table. Write the 0010 file from `compatMigration0010Sql("sqlite", storage.names)` for the same reason, or from `compatMigration0010Sql("sqlite", storage.names, "before-1.7")` for tables from before 1.7. The shipped 0010 adds `activeTeamId` to the default `session` table and `teamId` to the default `invitation` table. Write the 0012 file from `compatMigration0012Sql("sqlite", storage.names)` for the same reason. The shipped 0012 adds the plugin columns to the default `user` table and the flags to the default `passkey` table.
- Tables that hold `session.activeTeamId` and `invitation.teamId` already: Better Auth's `teams` option adds these two columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the shipped 0010 fails on these tables with `duplicate column name: activeTeamId`. Such an app writes its own 0010 file. It is the shipped file of its directory (`d1` or `d1-before-1.7`) without its two `ALTER TABLE ... ADD COLUMN` lines of `session` and `invitation`. The other lines must stay. They create the `organizationRole`, `team`, and `teamMember` tables when they are absent. They add `taRank`, the `ta` columns, and the unique keys, and move the versions. It applies the files to 0009, its own 0010, and the shipped 0011 and 0012 with `wrangler d1 migrations apply` before `authtempo migrate --target d1 --tables compat`. Then the compat version is 12, and the command copies nothing.
- Tables that hold the columns of Better Auth's username, phone number, or anonymous plugin: the shipped 0012 adds these columns too, so on such tables it fails with `duplicate column name`. Such an app writes its own 0012 file without the `ADD COLUMN` line of each column that the table holds, and without the unique key that it holds.

`wrangler d1 migrations apply` rolls back a file that fails (wrangler
4.148.0, read 2026-10-10), so a refused file changes nothing. A runner that
does not roll back, such as `wrangler d1 execute --file`, can keep the empty
`ta_date_check` table of a refused date check. The next run uses that table
and drops it. The errors that a refused file gives:

- `no such column: issuer`: the 1.7 file on tables from before 1.7. Use the `d1-before-1.7` file.
- `duplicate column name: issuer`: the `d1-before-1.7` file on 1.7 tables. Use the `d1` file.
- `table ta_limit already exists`: the compat migration ran already.
- `duplicate column name: activeTeamId`: the shipped 0010 on tables that hold the teams columns already. Use an own 0010 file: the shipped file without its two `ADD COLUMN` lines of `session` and `invitation`.
- `duplicate column name: memberCount`: the `d1-before-1.7` 0010 on the team tables of Better Auth 1.7. Use the `d1` file.
- `UNIQUE constraint failed: organizationRole.organizationId, organizationRole.role` (Postgres: `could not create unique index "ux_organization_role__organization_id__role"`): two role rows of one name in one organization. Better Auth checks the name before a create but has no unique key. Find them with `SELECT "organizationId", role, count(*) FROM "organizationRole" GROUP BY "organizationId", role HAVING count(*) > 1`. Delete or rename one row of each pair, and run the file again.
- `UNIQUE constraint failed: teamMember.teamId, teamMember.userId` (Postgres: `could not create unique index "ux_team_member__team_id__user_id"`): two team member rows of one pair. Better Auth 1.7 stops such rows with its `membershipKey`, but a row from before 1.7 has no key. Find them with `SELECT "teamId", "userId", count(*) FROM "teamMember" GROUP BY "teamId", "userId" HAVING count(*) > 1`. Delete one row of each pair, and run the file again.
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
| An absolute `callbackURL` or `redirectTo` on any trusted origin | Only the origin of `authtempo.appURL` (default the origin of `baseURL`, or of the request's entry of a list) keeps its path, because core lands every sign-in there. Any other absolute value answers `INVALID_CALLBACK_URL` or `INVALID_REDIRECT_URL`, status 403. |
| A reset keeps the other sessions | A reset ends every session. |
| The verify link lives 1 hour beside a magic link of 5 minutes | Both live as long as the magic link. With the magic link plugin and no `emailVerification.expiresIn`, the verify link lives 300 s, not 3600 s, and a note says so at start. |
| `trustedOrigins` takes a function and wildcards such as `https://*.example.com` | Each entry is an exact origin (`https://app.example.com`, no path or trailing slash) or an app scheme (`myapp://`). Any other entry is refused at start. |
| `baseURL` takes `{ allowedHosts, fallback, protocol }` with wildcard hosts, and `protocol: "auto"` reads `x-forwarded-proto` | Each host must be exact, and `protocol` must be `https` or `http`; a wildcard, `auto`, and no `protocol` are refused. The hosts map to core's `baseURL` list, and a `fallback` equal to one of them is the primary. Core picks the host from the request URL and reads no proxy header. The shim builds its own paths, SSO URLs, and mail links on that host. Each host is also a trusted origin, as in Better Auth, so a page on one host posts to another. A wildcard on a shared platform lets any customer of the platform own a host of the issuer. |

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
| A delete answers `DELETE_TOO_LARGE` (409) before any write when the user alone holds more than 50 organizations. On D1 it also answers it when its least work cannot fit 50 queries | Core deletes the account in one transaction, and D1 Free allows 50 queries per invocation |
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
answers `invalid_token`. Without the plugin, it answers 404. Since plan 12i
Task 16, two more paths of the list answer. `/callback/<provider>` is core's
provider callback on an https `baseURL`, and it answers 404 on http.
`/sign-in/social` with `idToken` is core's ID-token sign-in, and it answers
404 without `idToken`. The handler
serves `/get-session`, the eleven account paths of plan 12a, and
`/passkey/update-passkey` in Better Auth's shapes, so they are not in this list. See "The session read" and "Account operations". The email code paths are not in
it either (see "Email codes"), nor the paths of the sign-in plugins (see "Sign-in plugins").

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
| `organization` | Core's organizations, mailed invitations, and Better Auth's roles: `ac`, `roles`, and `dynamicAccessControl` map onto core's statements, roles, and dynamic roles (see "Access control and roles"). `teams` maps onto core's teams (see "Teams"). With no `roles`, the roles are Better Auth's member < admin < owner. `sendInvitationEmail` is required. Its `data.id` and `data.invitation.id` hold the invitation token, not the row id: build the accept link from it, and `acceptInvitation({ invitationId })` sends it back. `api.createInvitation` and `api.cancelInvitation` use the row id. |
| `passkey` | Core's passkeys. `rpID`, `rpName`, and `origin` are required; each origin must be `baseURL` or in `trustedOrigins`. `registration.requireSession: true` maps. `requireSession: false`, `resolveUser`, and `afterVerification` are refused: core makes every user. Core's `passkey.signUp` is the sign-up by passkey, and the shim does not map it (deviation 6 of plan 12i). |
| `magicLink` | Core's magic link with its confirm page. `sendMagicLink` is required. Without the plugin the magic link paths answer 404. |
| `emailOTP` | Core's email codes (plan 9e): the sign-in code and the reset code. `sendVerificationOTP` is required. It gets `type: "sign-in"` or `type: "forget-password"`, never another type, and a reset code goes only to an address with a user, as in Better Auth. Without the plugin core's code routes answer 404. See "Email codes". |
| `bearer` | Core reads `Authorization: Bearer` on every route already. The plugin adds `set-auth-token` to every response that sets the session cookie. |
| `expo` | Core's handoff for the system browser. `trustedOrigins` must hold the app scheme, for example `reception://`. `expo-origin` becomes `origin` when a request has none. On Expo, `signIn.social` and `signIn.magicLink` open core's sign-in page, which lists every method this server serves: the magic link form only with the `magicLink` plugin, the password form with `emailAndPassword`, a social button per provider, and the passkey button with the `passkey` plugin. The provider is not chosen in advance. A config with `expo` and none of these methods is refused at start. |
| `apiKey` | Core's API tokens (plan 12k Task 12): `references: "user"` gives user tokens (`tk_`), and `"organization"` gives organization tokens (`to_`). See "API keys". |
| `twoFactor` | Core's TOTP second factor (plan 9f) on the password sign-in. Needs `emailAndPassword.enabled`. `/two-factor/enable` (the password) answers `{ method: "totp", totpURI, backupCodes }`; `/two-factor/verify-totp` with the session turns the factor on and ends the other sessions; at the next sign-in core answers a challenge and sets `better-auth.two_factor`, and `verify-totp` or `verify-backup-code` with that cookie opens the session. `trustDevice: true` sets `better-auth.trust_device` for `trustDeviceMaxAge` (whole days, default 30). `disable`, `get-totp-uri`, and `generate-backup-codes` take the password. `send-otp`, `verify-otp`, and `method: "otp"` answer `NOT_SUPPORTED` (501). Pass `accountLockout: { enabled: false }`: core has no account lockout. `user.twoFactorEnabled` comes from core's `ta_second_factor` row; the Better Auth `twoFactor` table is not read. Backup codes are 23 characters (`backupCodeOptions.length` 23 to 32). Core's gate on the magic link, the email code, social, and the phone code stays off, as in Better Auth. A reset by code of a user with the factor on opens no session on a device that is not trusted (plan 12c). |

| `admin` | Core's operator tools (plan 12f). Needs `organization` and `authtempo.platformOrganization`. See "The admin plugin". |
| `sso` | Core's OIDC and SAML connections and its domain proof (plan 12d). Needs `organization` and `authtempo.ssoDns`. See "SSO and SCIM". |
| `scim` | Core's SCIM server (plan 12d). Needs `organization`. Each static credential acts on one organization. See "SSO and SCIM". |
| `anonymous` | Core's anonymous sign-in (plan 12i Task 16). See "Sign-in plugins". |
| `username` | Core's username and the password sign-in by username. Needs `emailAndPassword.enabled`. See "Sign-in plugins". |
| `phoneNumber` | Core's phone code. `sendOTP` delivers each code that core makes. Needs `authtempo.phone.regions`. See "Sign-in plugins". |
| `oneTap` | Core's ID-token route for Google, with no nonce. Needs `socialProviders.google`. See "Sign-in plugins". |
| `multiSession` | Core's multi-session: `maximumSessions` (2 to 10, default 5) is core's `multiSession.max`. See "Sign-in plugins". |
| `lastLoginMethod` | Core's last method cookie under Better Auth's cookie name. See "Sign-in plugins". |

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
| `adminRoles` | One role of the organization plugin, default `admin`: a key of its `roles`, or `member`, `admin`, or `owner` with no `roles` (plan 12k). It is the platform role. A list with two roles, or a name that is no such role, is refused. |
| `impersonationSessionDuration` | Seconds, a whole number of minutes from 5 to 240; default 3600. It is core's `operator.impersonation.ttlMinutes`. Core mails the user a notice at each start. |
| `defaultRole` | `"user"` only, Better Auth's default. |
| `allowImpersonatingAdmins` | `false` only: core never lets an operator impersonate a platform operator. |
| `defaultBanReason`, `defaultBanExpiresIn`, `bannedUserMessage`, `adminUserIds`, `schema`, `ac`, `roles` | Refused. Each refusal names spec section 26. |

Four calls that core does not serve answer `NOT_SUPPORTED` (501) with a
line that names spec section 26. They are `/admin/set-user-password`,
`/admin/list-user-sessions`, `/admin/revoke-user-session`, and
`/admin/has-permission`. No operator sets a
password (plan 12f2): a password that an operator knows signs in outside an
impersonation. The person resets the password through the reset link. The
refusal comes before any read, so its answer is the same for every user id.

`/admin/update-user` takes `data.name` and `data.image` only, as core's
operator update does (plan 12f2). An empty name clears the name, as `null`
does. Each other key of `data` is refused before any read, and nothing is
written. After the password, the shim checks the keys in Better Auth's
order: the role, the ban keys, then the address. It never drops a key in
silence:

| Key of `data` | Answer |
| --- | --- |
| None | 400 `NO_DATA_TO_UPDATE`, Better Auth's code. |
| `password` | 400 `PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER`, Better Auth's code. The line names spec section 26 and the reset link. |
| `role` | 403 `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`, Better Auth's code. Use `/admin/set-role`. |
| `banned`, `banReason`, `banExpires` | 403 `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS`, Better Auth's code. Use `/admin/ban-user` and `/admin/unban-user`. |
| `email`, `emailVerified` | 403 `YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL`, Better Auth's code. The person changes the address and proves it (spec section 8.15 item 5). |
| Any other key | 400 `FIELD_NOT_ALLOWED`, with a line that names the key and spec section 26. |

`/admin/create-user` takes `email`, `name`, `data.emailVerified`, and
`data.image`, as core's operator create does (plan 12f2). An empty name is
no name. The shim sends core's `firstSignIn: "none"`, because Better Auth
mails nothing at create: core writes no invitation and mails no link. The
person signs in by a path of the app, such as the reset link or a magic
link. `data.emailVerified: true` makes core take the address as proved, and
the audit row records the flag. No later proof of the address resets the
account, so a wrong address gives the account to the owner of that
address. Set it only after your own check of the address. Each other key
is refused before any read, and nothing is written.
The shim never drops a key in silence:

| Key | Answer |
| --- | --- |
| `role` of a form other than a string or a list of strings, such as `null` | 400 `VALIDATION_ERROR`, before any other check, as Better Auth's body schema answers. |
| `role` or `data.role` with a value that is no string | 400 `INVALID_ROLE_TYPE`, Better Auth's code. |
| `password` | 403 `YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD`, the code of Better Auth's password set. No operator sets a password; the line names the reset link and spec section 26. |
| `role` or `data.role` other than `user` | 403 `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`, Better Auth's code. Grant the platform role through `/admin/set-role`. `user` and `["user"]` add nothing. |
| `data.banned`, `data.banReason`, `data.banExpires` | 403 `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS`, Better Auth's code. Use `/admin/ban-user`. |
| Any other key of `data` (`name`, `email`, `phoneNumber`, an added field) | 400 `FIELD_NOT_ALLOWED`, with a line that names the key and spec section 26. |

A taken address answers 400 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` and a
malformed address 400 `INVALID_EMAIL`, as Better Auth answers. An address in
a placeholder form answers 403 `HOOK_REFUSED` before any write: it reads
back as no address, so it is never proved.

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
| `POST /admin/update-user` | `POST /operator/users/update` | The user itself, as Better Auth answers it, not `{ user }`. Core writes the change and its audit row `user_update` in one transaction. |
| `POST /admin/remove-user` | `POST /operator/users/delete` | `{ success: true }`. Core deletes the account and each organization that the user alone holds, and writes the audit row `user_delete`. On the D1 storage, a solo owner answers `DELETE_TOO_LARGE`: see below. |
| `POST /admin/create-user` | `POST /operator/users/create` | `{ user }`, as Better Auth answers it, with `role: "user"`. Core writes the user and its audit row `user_create` in one transaction, and runs `user.beforeCreate` and `user.afterCreate`. |

`auth.api` has Better Auth's server calls of these paths: `listUsers`,
`getUser`, `banUser`, `unbanUser`, `setRole`, `revokeUserSessions`,
`impersonateUser`, `stopImpersonating`, `adminUpdateUser`, `removeUser`,
and `createUser`. Each takes Better Auth's
`query` or `body` and the caller's `headers`, and runs the steps of its
path. So it answers what the path answers, with dates as `Date` values. A
refusal throws `APIError` with the status and the code of the path. Without
`admin()`, each call throws 404. A server call with no request headers has
no session, so it answers 401 `UNAUTHORIZED`, as the path does. The shim
makes no app actor: an app actor would delete an account with no person and
no second factor (ruling 1 B9 of plan 12f2). Server code that acts as the
app calls `auth.tempo.api.operator` with its own actor.

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
| `operator_required` (the guard, or a target that is a platform operator) | 403 with the code of the path: `YOU_ARE_NOT_ALLOWED_TO_LIST_USERS`, `YOU_ARE_NOT_ALLOWED_TO_GET_USER`, `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS` (ban and unban), `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`, `YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS`, `YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS`, `YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS`, `YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS`, or `YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS`. |
| `impersonation_refused` (the operator, a platform operator, a banned user, or an absent user) | 403 `YOU_CANNOT_IMPERSONATE_ADMINS`. |
| `impersonation_session` (an impersonation session starts another one) | 403 `FORBIDDEN`. |
| `not_found` on a stop (the session impersonates nobody) | 400 with Better Auth's message `You are not impersonating anyone`. |
| `operator_self` | 409 `YOU_CANNOT_BAN_YOURSELF` on a ban, 400 `YOU_CANNOT_REMOVE_YOURSELF` on a remove (Better Auth's status), else 409 `FORBIDDEN`. |
| `sole_owner` (a remove of the last owner of an organization with other members) | 409 `SOLE_OWNER`. Hand the organization over first. |
| `delete_too_large` (a remove of a user who alone holds more than 50 organizations, or on D1 a remove that does not fit one invocation) | 409 `DELETE_TOO_LARGE`. Delete or hand over the user's solo organizations, or let the user leave the organizations that the user owns with another owner, first. |
| `email_taken` on a create | 400 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, Better Auth's code and status. |
| `invalid_body` on a create with a malformed address | 400 `INVALID_EMAIL`, Better Auth's code. |
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
- `/admin/update-user` takes `name` and `image` only. Better Auth also sets
  the address, the role, the ban fields, and any added field. The
  update of the caller's own user answers 409 `FORBIDDEN`.
- `/admin/remove-user` on the D1 storage answers `DELETE_TOO_LARGE` for a
  user who alone holds an organization (test run of 2026-10-25). A
  platform operator has the smallest query budget of the operator acts, and
  this act does not fit it. Delete the organization first. Or let the app
  delete the account in process with
  `auth.tempo.api.operator.users.delete`, which fits in 47 queries with 60
  sessions.
- `/admin/remove-user` deletes the user's solo organizations with the
  account, and refuses the last owner of an organization with other members
  (`SOLE_OWNER`). Better Auth keeps every organization.
- `/admin/create-user` takes no password, no role but `user`, no ban key,
  and no added field. Better Auth sets each one. A server call with no
  headers answers 401: Better Auth creates the user there with no session.
- A refusal of a create-user key comes before the session check. So a
  caller with no session who sends a password gets 403, not 401.

On D1, an act reads the user row once after core's route, for `{ user }`.
With `twoFactor()`, it also reads the factor row once.
A ban of a user with 60 sessions sends 35 queries in its invocation.
A ban of a user with 501 sessions sends 49: core ends one page of sessions
in the budget, and the sweep ends the rest.
An impersonation start sends 33 queries and a stop 19, each with the
shim's read of the session for `{ session, user }`.
A remove adds no query to core's delete route: it answers
`{ success: true }` with no read. An update reads the user row once after
core's route, and the factor row once with `twoFactor()`.
A create sends 17 queries in its invocation, with the read of the user row
and the factor row.

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
## Access control and roles

Since plan 12k (Task 10, spec 29 item 18), the package has
`better-auth/plugins/access` and `better-auth/plugins/organization/access`,
with Better Auth 1.7.2's shapes. They give `createAccessControl`, `role`, and
Better Auth's default statements and roles. `role().authorize(request, connector?)`
keeps Better Auth's AND and OR and its answer texts. It only hides a control:
the server check is core's.

The server maps the options onto core's organizations:

- `ac.statements` without Better Auth's five resources (and without `apiKey`) is core's `organizations.statements`: the app's own resources.
- Each role of `roles` is a role of core's `organizations.roles`, with its statements as its permissions. An empty list goes. Each role also gets `member: ["read"]`, and a role with `invitation: ["create"]` gets `invitation: ["read"]`. Better Auth 1.7.2 lets every member list the members and the invitations, and core asks for the statement. So the shim is stricter on the invitations, and fails closed: a role that does not invite cannot list them (a deviation, ruling 35).
- `apiKey` is core's `apiToken`, in `ac`, in `roles`, and in a stored role. Core's actions of `apiToken` are `read`, `create`, `update`, and `revoke`. Since plan 12k Task 12, Better Auth's `delete` of `apiKey` is core's `revoke`, both ways. Better Auth asks `apiKey:delete` before it deletes an organization key. A role with any other action of `apiKey` is refused at start. An `ac` resource or a role resource named `apiToken` is refused, because it would get core's token rights. An `ac` action of a core resource that core lacks is refused, not dropped.
- Better Auth's roles have no rank, and core's owner rules need one. `authtempo.roleRanks` gives each role of `roles` its rank, a positive integer. A role with no rank is refused at start (`authtempo.roleRanks must rank <name>`), and so is a rank of a name that `roles` lacks. `authtempo.roleRanks` with no `roles` is refused too, because the default ranks are fixed. `roles` must name `owner`, the creator role. With no `roles`, the roles are Better Auth's `defaultRoles`, ranked member 1, admin 2, owner 3, with the two reads above.
- `dynamicAccessControl: { enabled: true }` turns on core's `organizations.dynamicRoles`. `maximumRolesPerOrganization` takes an integer from 1 to 1000; a function is refused, as for the other limits. Better Auth has no cap by default; core caps at 50 when the option is absent.
- A role string with two parts, for example `admin,closer`, holds the union of both parts on the server (core's rule). Better Auth's check needs one part that holds the whole request, and `checkRolePermission` on the client keeps that rule. So the client can hide a control that the server allows.

The roles of an organization stay in place in Better Auth's `organizationRole`
table. Migration 0010 creates the table with Better Auth's own SQL when it is
absent. It adds `taRank` (integer, NOT NULL, default 1) and the unique key on
(`organizationId`, `role`). `permission` stays Better Auth's JSON text: the
storage parses it and maps `apiKey` onto `apiToken`. It adds the list reads of
a static role in memory: `member: ["read"]`, and `invitation: ["read"]` when
the row holds `invitation: ["create"]`. A write writes Better Auth's names back
and removes no action, so a write never takes away a stored right. The text
can gain the two reads at its next write. Better Auth 1.7.2 lists the members
and the invitations with no permission check, so they change no answer of
Better Auth. A row whose text
does not parse grants nothing, and so does a row whose permissions name an
unknown resource or action. Core logs `authtempo: role row invalid <id>` for
each. A row of Better Auth reads with rank 1 until an owner
changes it, and its null `updatedAt` reads as its `createdAt`.

A row named as a static role (a role of `roles`, or of the defaults) is never
read. The static role wins (core's role rule 1). Better Auth let such a row add
permissions to the static role. Find these rows before the cutover:

```sql
SELECT id, "organizationId", role FROM "organizationRole" WHERE role IN ('owner', 'admin', 'member')
```

Put the names of `roles` in the list in place of Better Auth's three. A row
that Better Auth wrote holds no `member: ["read"]`. The read adds it, so a
person whose only role is such a row lists the members, as in Better Auth.

The client has Better Auth's role calls, on core's routes under
`/organizations/roles`. They are `organization.createRole`, `deleteRole`,
`listRoles`, `getRole`, `updateRole`, and `hasPermission`, in Better Auth's
shapes. `checkRolePermission` reads the roles of
`organizationClient({ ac, roles })`.
Each write needs a fresh session and core's `ac` statement. Core's role routes take the name, not the id. So `getRole`, `updateRole`, and `deleteRole` with `roleId` list the roles first, and need `ac:read` as well. Better Auth's update and delete by `roleId` need only `ac:update` and `ac:delete`. Pass `roleName` to need one statement only. A role's
`additionalFields`, a new `roleName` in `updateRole`, and
`allowCreatorAllPermissions: true` answer `NOT_SUPPORTED` (501). The codes are
Better Auth's: `ROLE_NAME_IS_ALREADY_TAKEN`, `TOO_MANY_ROLES`, and
`ROLE_IS_ASSIGNED_TO_MEMBERS`, with core's status 409, where Better Auth answers
400. The handler serves none of Better Auth's role paths.

## Teams

Since plan 12k (Task 11, spec 29 item 19), `organization({ teams })` maps
onto core's `organizations.teams` and two limits. A team has no role: every
right comes from the organization role (`team:create`, `team:update`, and
`team:delete`; `member:update` for a team member add).

- `teams: { enabled: true }` turns teams on, with Better Auth's defaults. A
  create of an organization also creates a team named as the organization,
  with the creator in it. The delete of the last team answers
  `UNABLE_TO_REMOVE_LAST_TEAM`.
- `defaultTeam: { enabled: false }` maps onto `defaultTeam: false`.
  `allowRemovingAllTeams: true` maps onto `keepLastTeam: false`, and `false`
  or no value maps onto `keepLastTeam: true`.
- `maximumTeams` maps onto `limits.teamsPerOrganization`, and
  `maximumMembersPerTeam` onto `limits.membersPerTeam`. Each takes a positive
  integer. Core counts inside a transaction after a lock, so the limit holds
  under a race on Postgres. A function form is refused, as for the other
  limits. `defaultTeam.customCreateDefaultTeam` is refused: core creates the
  default team itself.
- The codes are Better Auth's: `YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_TEAMS`,
  `TEAM_MEMBER_LIMIT_REACHED`, and `UNABLE_TO_REMOVE_LAST_TEAM`, with core's
  status 409, where Better Auth answers 400, 403, and 400.

The teams stay in place in Better Auth's `team` and `teamMember` tables.
Migration 0010 creates both with Better Auth's own SQL when they are absent.
Better Auth 1.7.2 has `team.memberCount` and `teamMember.membershipKey`, and
the team tables of 1.4.21 have neither. Core writes both, so 0010 adds each
column when it is absent: `memberCount` as `integer NOT NULL DEFAULT 0`, and
`membershipKey` as nullable text with the unique index
`ux_team_member__membership_key`. Postgres tests for each column. On D1 the
`d1-before-1.7` file creates absent team tables in the 1.4.21 form and then
adds both columns. A row from before 1.7 keeps a null `membershipKey`. The
shim read the team schema of Better Auth 1.4.21 (from the pnpm store) and
1.7.2 on 2026-10-21. No copy of 1.5 or 1.6 was on the machine, so the shim
did not read their team schema.
It adds `teamMember.taOrganizationId`, filled from the team's
`organizationId`, and `teamMember.taUpdatedAt`, filled from `createdAt`, and
the unique key on (`teamId`, `userId`). A team member row that Better Auth
writes after the migration has no `taOrganizationId`, so core cannot read it.
Do not run Better Auth's team routes after the cutover.

- `team.memberCount` is written 0 at the create and never updated. Core counts
  the rows. Better Auth counts the rows again before its next add, so a
  rollback finds the right count.
- `teamMember.membershipKey` is Better Auth's own key: the base64url SHA-256
  of `JSON.stringify([teamId, userId])`, with no padding. A Better Auth read by
  the key and a core write agree.
- `invitation.teamId` holds the team ids joined by `,`, as Better Auth writes
  it. Core reads it as `teamIds`.
- `session.activeTeamId` is Better Auth's own column. The session of
  `auth.api.getSession` and of the client's `getSession` answers it as
  `activeTeamId`, null with no active team.

Core fires the ten team hooks of `organizationHooks` (see "Hooks"). It fires
no team hook for the default team of a create, where Better Auth fires
`beforeCreateTeam` and `afterCreateTeam`. So the factory refuses these two
hooks while teams and the default team are on (spec 29 item 19). To keep
them, set `teams.defaultTeam: { enabled: false }`, and create the team in
`afterCreateOrganization` through `auth.tempo.api.createTeam`. That create
fires both hooks.

An organization create changes no session: the active organization and the
active team stay as they are. Better Auth sets both to the new organization
and its default team, unless `keepCurrentActiveOrganization` is true. After
the create, call `organization.setActive` and then
`organization.setActiveTeam`.

The client has Better Auth's team calls in Better Auth's shapes, on core's
routes under `/organizations/teams`. They are `organization.createTeam`,
`updateTeam`, `removeTeam`, `listTeams`, `setActiveTeam`, `listUserTeams`,
`listTeamMembers`, `addTeamMember`, and `removeTeamMember`. A team's
`additionalFields` answer `NOT_SUPPORTED` (501). `listUserTeams` lists the
teams of the session's user only: a `userId` of another person answers
`YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER` (403). `addTeamMember` of a user
who is no member of the organization answers
`USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` with core's status 404, where Better
Auth answers 400.

`organization.checkSlug({ slug })` runs core's slug check. A free slug answers
`{ status: true }`, as in Better Auth. A taken or reserved slug answers
`ORGANIZATION_SLUG_ALREADY_TAKEN` with core's status 409, where Better Auth
answers 400. A slug that core's slug rule refuses answers `VALIDATION_ERROR`
(400). The check runs in core's limiter.

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
- `overrideDefaultEmailVerification: true` is core's
  `password.verifyBy: "code"` (plan 12i Task 20). The sign-up mails a code
  through `sendVerificationOTP` with the type `email-verification`, and
  `emailVerification.sendVerificationEmail` is then not required.
  `otpLength`, `expiresIn`, and `allowedAttempts` set this code too, as in
  Better Auth (`password.verifyCode`, ruling 39). Better Auth's defaults
  apply: 6 digits, 300 seconds, and 3 tries. An `expiresIn` over 1800
  seconds is refused with this option: core's sign-up code lives at most
  30 minutes.
- The shim sets `password.uniformSignUp: false`, as Better Auth does. So
  the sign-up answer tells a known address. Core mails the resend code of
  `email-verification` after the answer. On Workers, pass
  `{ waitUntil: (p) => ctx.waitUntil(p) }` to `auth.handler`: the handler
  passes it to core, and the mail goes out after the answer. Without it,
  the handler waits for the mail on Workers. Then the answer time tells an
  unverified user with a password (ruling 39 Info 5 of plan 12i).
- Refused by name: `generateOTP`, `sendVerificationOnSignUp: true`,
  `resendStrategy: "reuse"`, and `rateLimit`.

`auth.handler` serves these Better Auth paths in Better Auth's shapes,
because apps post them by hand. An error answers `{ code, message }` with
authtempo's status.

| Path | Body | Answer |
| --- | --- | --- |
| `/email-otp/send-verification-otp` | `{ email, type }` | `{ success: true }` for `sign-in` and `forget-password`, and for `email-verification` with `overrideDefaultEmailVerification`: a new sign-up code to an unverified user with a password, sent after the answer; 400 `INVALID_EMAIL` for a malformed address, as Better Auth does; 501 `NOT_SUPPORTED` for `change-email`, and for `email-verification` without the override |
| `/email-otp/verify-email` | `{ email, otp }` | With `overrideDefaultEmailVerification`: `{ status: true, token, user }` with the session cookie, as Better Auth answers with `autoSignInAfterVerification`; `token: null` and no cookie for a user already verified; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`. Core runs its claim rule here, as at the verify link |
| `/sign-in/email-otp` | `{ email, otp }` | `{ token, user }` with the session cookie; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`; 501 `NOT_SUPPORTED` for `name`, `image`, or another user field |
| `/forget-password/email-otp`, `/email-otp/request-password-reset` | `{ email }` | `{ success: true }` |
| `/email-otp/request-email-change` | `{ newEmail }` | With `changeEmail.enabled`: `{ success: true }`. The code goes to the new address with the type `change-email`. A taken address gets no code, as in Better Auth. A stale session answers 403 `SESSION_NOT_FRESH` |
| `/email-otp/change-email` | `{ newEmail, otp }` | With `changeEmail.enabled`: `{ success: true }`, and the address moves; 400 `INVALID_OTP` for a wrong code or a `newEmail` that differs from the request |
| `/email-otp/reset-password` | `{ email, otp, password }` | `{ success: true }` with the session cookie of the new session; for a user with the second factor on, `{ success: true }` with no cookie unless the device is trusted, as Better Auth answers every reset, and the next sign-in asks for the factor (plan 12c); 400 `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` before the code check, so the code stays usable, as in Better Auth; 400 `INVALID_OTP`, `TOO_MANY_ATTEMPTS`, `INVALID_PASSWORD`, `PASSWORD_COMPROMISED` |

`/email-otp/check-verification-otp` answers 501 `NOT_SUPPORTED`. So does
`/email-otp/verify-email` without `overrideDefaultEmailVerification`, and so
do the two change paths without `changeEmail.enabled`. A wrong, expired, or spent code answers `INVALID_OTP`:
core does not tell expiry from a wrong code, so `OTP_EXPIRED` never
appears. Better Auth answers `TOO_MANY_ATTEMPTS` with 403; authtempo with
400. A password that the policy refuses for another reason than its length
spends the code: request a new one.

## Sign-in plugins

Plan 12i Task 16 maps six sign-in plugins of Better Auth 1.7.2 onto core
(each read 2026-10-25 in `dist/plugins/<id>/`). Each option maps onto core
or is refused at start with its Better Auth name. Import each plugin from
`better-auth/plugins`, and each client plugin (`anonymousClient`,
`usernameClient`, `phoneNumberClient`, `multiSessionClient`,
`lastLoginMethodClient`) from `better-auth/client/plugins`. The client has
the calls with or without them; the server answers 404 for a plugin that
is off.

| Plugin | Maps | Refused |
| --- | --- | --- |
| `anonymous` | `emailDomainName`; `onLinkAccount` runs from core's `hooks.anonymous.afterLink`; `generateName` names the user, else "Anonymous" | `generateRandomEmail`, `disableDeleteAnonymousUser: true`, `schema`, and the plugin when every method sets `disableSignUp` |
| `username` | `minUsernameLength` and `maxUsernameLength`, 3 to 30 | `usernameValidator`, `displayUsernameValidator`, `usernameNormalization`, `displayUsernameNormalization`, `validationOrder`, `immutableUsername: true`, `displayUsername: false`, `schema` |
| `phoneNumber` | `sendOTP` as core's SMS port; `expiresIn` (60 to 600 seconds, rounded up to whole minutes); `otpLength` (6 or 8); `allowedAttempts` (3 to 10); `requireVerification`; `signUpOnVerification` (core's `phone.signUp`) with `getTempName` | `verifyOTP`, `sendPasswordResetOTP`, `phoneNumberValidator`, `callbackOnVerification`, `schema` |
| `oneTap` | Core's `social.idToken` with `requireNonce: false`; `clientId` only as `socialProviders.google.clientId`; `disableSignup` votes in core's one sign-up rule | Another `clientId` |
| `multiSession` | `maximumSessions`, 2 to 10 | Another value |
| `lastLoginMethod` | `cookieName` (default `better-auth.last_used_login_method`) and `maxAge` (whole days, 1 to 400) | `storeInDatabase: true`, `customResolveMethod`, `beforeStoreCookie`, `schema` |

`auth.handler` serves these Better Auth paths in Better Auth's shapes. Each
posts core's own route, so core's Origin rule, limits, gate, and cookies
hold. An error answers `{ code, message }` with authtempo's status. `auth.api`
has the same calls (`signInAnonymous`, `deleteAnonymousUser`,
`signInUsername`, `isUsernameAvailable`, `sendPhoneNumberOTP`,
`verifyPhoneNumber`, `signInPhoneNumber`, `oneTapCallback`, `signInSocial`,
`listDeviceSessions`, `setActiveSession`, `revokeDeviceSession`), and each
throws `APIError` on a refusal.

| Path | Core route | Answer |
| --- | --- | --- |
| `POST /sign-in/anonymous` | `/anonymous/sign-in` | `{ token, user }`; 400 `ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY` for a browser with an anonymous session, as Better Auth does |
| `POST /delete-anonymous-user` | `/anonymous/delete` | `{ success: true }`; 403 `USER_IS_NOT_ANONYMOUS` for a session that is not anonymous, as Better Auth does |
| `POST /sign-in/username` | `/password/sign-in` | `{ token, user }`; with `twoFactor`, Better Auth's redirect answer. `callbackURL` and `rememberMe: false` answer `NOT_SUPPORTED` |
| `POST /is-username-available` | `GET /username/available` | `{ available }` |
| `POST /phone-number/send-otp` | `/phone/request` with no session or an anonymous one, else `/phone/add` | `{ message: "code sent" }` for a known and an unknown number. With a session that is not anonymous, core's add needs a fresh session (`session.freshAge`, one day by default). An older session gets 403 `SESSION_NOT_FRESH`. Better Auth needs no fresh session here |
| `POST /phone-number/verify` | `/phone/verify`, or `/phone/add/verify` with `updatePhoneNumber: true` | `{ status: true, token, user }`. `disableSession: true` answers `NOT_SUPPORTED`. A code sent with a session that is not anonymous verifies only with `updatePhoneNumber: true`. With an anonymous session, the verify signs in and upgrades the anonymous user, and `onLinkAccount` runs, as in Better Auth. With an anonymous session and `updatePhoneNumber: true`, the verify answers 403 `ANONYMOUS_REFUSED`: Better Auth sets the number on the anonymous user, and core refuses a phone on an anonymous user |
| `POST /sign-in/phone-number` | `/password/sign-in` | As `/sign-in/username` |
| `POST /one-tap/callback` | `/social/google/id-token` | `{ token, user }`; 400 `INVALID_TOKEN` |
| `POST /sign-in/social` with `idToken` | `/social/<provider>/id-token` | `{ redirect: false, token, user }` for `google` and `apple`; `NOT_SUPPORTED` for another provider. `idToken.nonce` must come from core's `POST <basePath>/social/<provider>/id-token/nonce`, and the app gives its `providerNonce` to the provider. Without `oneTap`, a token with no nonce answers `INVALID_TOKEN`. Core keeps no provider token, so `accessToken`, `refreshToken`, and `expiresAt` are not stored |
| `GET /multi-session/list-device-sessions` | `GET /multi-session` | `[{ session, user }]`, the active session first. `session.token` holds the session id: the shim never holds a clear token |
| `POST /multi-session/set-active` | `/multi-session/switch` | `{ session, user }`. `sessionToken` is a `session.token` of the list |
| `POST /multi-session/revoke` | `/multi-session/sign-out` | `{ status: true }` |
| `POST /phone-number/request-password-reset`, `/phone-number/reset-password` | None | 501 `NOT_SUPPORTED`: core has no password reset by phone |

`signUp.email` and `update-user` take `username`. `displayUsername` must be
the typed username or absent: core keeps the typed case as
`displayUsername`, and another value answers `NOT_SUPPORTED`.

Each user that the server answers holds the fields of these plugins, as in
Better Auth: `isAnonymous` with `anonymous`, `username` and
`displayUsername` with `username`, and `phoneNumber` and
`phoneNumberVerified` with `phoneNumber`. The hooks get them too.
`phoneNumber` is the proved number or null, because core does not read a
number that Better Auth stored with no proof. With `anonymousClient`,
`usernameClient`, or `phoneNumberClient`, the client reads its session at
the shim's `/get-session`, which holds the fields. An answer of a core
route to the client, such as the email sign-in, holds the five user keys
only. Read the session for the fields.

The settings that Better Auth does not have:

- `authtempo.phone.regions` is required with `phoneNumber`: the
  calling-code prefixes that get an SMS, such as `["+1"]`. Core has no
  default. `authtempo.phone.dailyCap` is the codes of the deployment per 24
  hours, 1 to 100000, default 1000. Better Auth has no cap.
- `authtempo.anonymousDailyCap` is the anonymous users of the deployment
  per 24 hours, 1 to 100000, default 1000. Better Auth has no cap. A
  sign-in over the cap answers 429.
- Both caps need the shared limiter of the compat storage. The memory
  limiter is refused.

Behavior that differs from Better Auth:

- The placeholder address. Better Auth's `user.email` is NOT NULL, and a
  user of core can have no address. The storage writes
  `<id>@anonymous.placeholder.invalid` for a user with no address, or
  `temp-<id>@<emailDomainName>` with that option. It reads every address
  on `placeholder.invalid`, or on a subdomain of it, as no address. With
  `emailDomainName`, it reads `temp-<id>@<emailDomainName>` as no address
  only on the row whose id is `<id>`. Any other address at the domain
  stays an address, `temp-sales@<emailDomainName>` too. So a Better Auth
  anonymous user has no address in core, and so do a phone user of
  `getTempEmail` and a TikTok or WeChat user. Core never mails a
  placeholder, never finds a user by one, and never counts one as proved.
  A sign-up or a change of address to an address in a placeholder form
  answers 403 `HOOK_REFUSED` before any write. At `/change-email` and at
  core's `/user/change-email`, the refusal also comes before any mail.
  Better Auth takes such an address. One database takes one
  `emailDomainName`: a second instance on it with another domain is
  refused at start.
- A residual of the move: Better Auth 1.7.2 writes
  `temp-<random id>@<emailDomainName>`, not the row id, and
  `generateRandomEmail` writes any address. After the move, such an older
  row reads as a real, unverified address, and core treats it as the
  user's address. Before the move, rewrite each such row to
  `<id>@anonymous.placeholder.invalid`, for example with
  `UPDATE "user" SET email = id || '@anonymous.placeholder.invalid' WHERE "isAnonymous"`.
- `getTempEmail` must answer an address on `placeholder.invalid`, such as
  `<number>@phone.placeholder.invalid`. Another domain is refused at start,
  because its rows would read back as real addresses.
- `onLinkAccount` gets core's `proof`. Move the anonymous data only on
  `"verified"`: an `"unverified"` sign-in is a claim, and the real owner of
  the address can take the account later. Better Auth calls the hook for
  both, so the shim does too, and `betterAuth` logs one start note that
  says so. Each session is the newest row of its user, or null, and its
  `token` holds the hash of the token.
- `sendOTP` gets each code that core makes, keys, binds to its number, and
  counts. It is the one place where app code sees a code. Core sends a
  note to a number that another user holds. Better Auth has no sender for
  that note, so the shim sends nothing, and the port answers `sent`. The
  note counts against the daily cap. Core sends each code and note after
  the answer, at a sign-in request and at an add. So the answer time tells
  no account and no held number. A throw of `sendOTP` changes no answer,
  and core writes the line `sms.port_threw`. On Workers, pass
  `{ waitUntil }` to `auth.handler`. On Next, pass
  `{ waitUntil: (p) => after(p) }` (`after` from `next/server`) as the
  second argument of `toNextJsHandler`. On a serverless Node host, pass
  the host's `waitUntil` to `toNodeHandler` the same way. Without it, the
  send runs detached, and a host that freezes the function after the
  answer can delay or drop it.
- Core signs in by phone and password only with a number that its code
  proved. A number that Better Auth stored with no proof does not sign in,
  so `requireVerification` other than `true` logs a note.
- A proof of the address clears the phone of an unverified user, by the
  claim rule: a number on an unverified row can be a claimant's. Better
  Auth 1.7.2 keeps the number at an email verify. So a moved user who
  proved a number, but never the address, loses the phone sign-in at
  their own verify link, magic link, email code, or social sign-in. They
  add the number again with `/phone-number/send-otp` and
  `updatePhoneNumber: true`.
- The last method cookie holds core's values. The client maps them to
  Better Auth's names: `password` is `email`, `social:<id>` is `<id>`,
  `magic_link` is `magic-link`, `email_otp` is `email-otp`, and `phone` is
  `phone-number`. Core also sets the cookie at the sign-in by username,
  by phone, and by email code, where Better Auth sets none.
- One Tap: the shim serves `POST /one-tap/callback` only. It has no Google
  script loader, so the page calls Google's script and posts the token.
- One Tap sets `social.idToken.requireNonce: false` for every ID-token
  sign-in: Apple and `/sign-in/social` with `idToken` too, as in Better
  Auth. A token posted with no nonce then skips the nonce check, so a
  holder of a valid ID token for the app can sign in with it.
- The ID-token audiences. A Google `clientId` list gives core its first id
  as `clientId` and the rest as `social.google.audiences`. The Apple
  `audience`, else `appBundleIdentifier`, maps to `social.apple.audiences`.
  Core also takes an Apple token for `clientId` when `audience` is set,
  where Better Auth does not. Core refuses more than ten ids besides
  `clientId` at start.

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
  Since plan 12k Task 11, the ten team hooks map too: `beforeCreateTeam`,
  `afterCreateTeam`, `beforeUpdateTeam`, `afterUpdateTeam`,
  `beforeDeleteTeam`, `afterDeleteTeam`, `beforeAddTeamMember`,
  `afterAddTeamMember`, `beforeRemoveTeamMember`, and
  `afterRemoveTeamMember`. With the default team on, `beforeCreateTeam` and
  `afterCreateTeam` are refused at start (see "Teams"). `beforeCancelInvitation`
  and `beforeRejectInvitation` are refused at start.
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
  The shim calls them there through core's sign-up code (plan 12i Task 20),
  and answers that path `NOT_SUPPORTED` without
  `overrideDefaultEmailVerification`. Better Auth also calls them at
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

consumerc (follow-ups first): `hooks`, `beforeCreateOrganization`, `authtempo.roleRanks`, the import of `better-auth/db`, the Apple config, the session-end paths, the `getSchema()` test, and `advanced.ipAddress`. The leave guard of `leave.ts` moves into `organizationHooks.beforeRemoveMember`, which core runs on a leave. `beforeCreateOrganization` writes the studio with `organization.id` and returns nothing. A `{ data }` that changes the id stops the write (on Postgres with `max: 1`, on a second connection; see "Hooks"). `ac`, `roles`, and dynamic access control map since plan 12k, so `authtempo.roleRanks` ranks its five roles. Its own RANKS ranks viewer 0, and core takes 1 or more. The Apple config is `teamId`, `keyId`, `privateKey`. The session-end paths in `session-end.ts` move to `databaseHooks.session.create.after` and core's `afterEnd`. Set `advanced.ipAddress.ipAddressHeaders` (or `disableIpTracking: true`) before `toNodeHandler` or `toNextJsHandler` accepts the instance.
The factory refuses exactly these: `hooks`, `plugins[expo]`, `plugins[organization].roles.admin`, `plugins[organization].roles.member`, `plugins[organization].roles.operator`, `plugins[organization].roles.owner`, `plugins[organization].roles.viewer`, `plugins[organization].sendInvitationEmail`, `socialProviders.apple.clientSecret`, `socialProviders.apple`.

consumerd (follow-ups first): the list after the refusals.
The factory refuses exactly these: `baseURL`, `hooks`, `plugins[admin]`, `plugins[anonymous]`, `plugins[organization].disableOrganizationDeletion`, `plugins[organization].roles.admin`, `plugins[organization].roles.guardian`, `plugins[organization].roles.learner`, `plugins[organization].roles.owner`, `plugins[organization].roles.teacher`, `plugins[passkey].origin`, `rateLimit.customStorage`, `secret`.

The follow-ups of consumerd:
- `authtempo.platformOrganization` for the admin plugin (see "The admin plugin").
- Anonymous sign-in: replace Better Auth's own plugin object with this package's `anonymous({ emailDomainName: "anon.consumerd.app" })`. The storage then reads `temp-<id>@anon.consumerd.app` as no address on the row of that id. Rewrite the older anonymous rows before the move (see "Sign-in plugins", the residual of the move).
- `$context`, `getOrgAdapter`, and the rate limit storage.
- `authtempo.roleRanks` from its ROLE_RANK (`ac` and `roles` map since plan 12k).
- Its `packages/db/test/better-auth-schema.test.ts` calls `auth.api.createOrganization`, `createTeam`, and `addTeamMember`. The shim's `auth.api` has none of the three, so call `auth.tempo.api` with core's arguments. The same test expects `memberCount` 1 after a team member add. The shim writes 0 at the create and never updates it (deviation 11), so that expectation changes to 0.
- `hooks`: wrap the handler (see "Request hooks").

`freshAge: 600` and `deferSessionRefresh: true` run unchanged since plan 12a: core's window is 10 minutes, and the shim's client posts the deferred refresh. `membershipLimit: 50` and `organizationLimit: 3` run unchanged since plan 9d. `teams: { enabled: true }` runs unchanged since plan 12k: Better Auth's default team and its last-team rule hold. The `emailOTP` options (`otpLength: 6`, `expiresIn: 600`, `allowedAttempts: 5`, `storeOTP: "hashed"`) run unchanged since plan 9e. The tests that post `/email-otp/send-verification-otp` and `/sign-in/email-otp` keep their paths. The test that reads the verification row by `sign-in-otp-<email>` reads `identifier = <email>` and `"taPurpose" = 'email-otp'` instead. With snake-case names, the column is `ta_purpose`. The row holds a keyed hash, never the code.

consumerb (follow-ups first): the list after the refusals.
The factory refuses exactly these: `advanced.defaultCookieAttributes.secure`, `emailAndPassword.sendResetPassword`, `emailVerification.expiresIn`, `plugins[admin]`, `plugins[cimd]`, `plugins[jwt]`, `plugins[mcp]`, `plugins[organization].roles.admin`, `plugins[organization].roles.member`, `plugins[organization].roles.owner`, `plugins[organization].roles.viewer`, `plugins[organization].sendInvitationEmail`, `plugins[passkey].origin`.

The follow-ups of consumerb:
- The API key edits of "Cutover of API keys" (the `to_` bearer and the Drizzle reads of `apikey`).
- The OAuth 2.1 provider through `mcp` and `cimd`.
- `jwt` and JWKS, refused since plan 9g (see "JWT and the OAuth provider").
- `authtempo.platformOrganization` for the admin plugin (see "The admin plugin").
- `authtempo.roleRanks` for its four roles, from its own RANK in `src/roles.ts` (`ac` and `roles` map since plan 12k).
- `defaultCookieAttributes.secure` and the `.well-known` routes.
- `advanced.ipAddress.ipAddressHeaders` (or `disableIpTracking: true`) before `toNodeHandler` or `toNextJsHandler` accepts the instance.

## API keys

Since plan 12k (Task 12, spec 29 item 20), `apiKey(options)` of
`@better-auth/api-key` maps onto core's API tokens. Every option of
@better-auth/api-key 1.7.5 maps, is a note, or is refused at start. The shim
reads api-key 1.7.5, consumerb's pin, beside the Better Auth 1.7.2 target of
the rest of this package. `BETTER_AUTH_API_KEY_VERSION` of `./api-key` holds
it, and a test pins it. Core's
tokens keep core's own tables, `ta_api_token` and `ta_organization_token`
(owner decision 4 of 2026-10-14). Migration 0010 creates them. Better Auth's
`apikey` table stays as it is: no migration writes it or drops it.

- `references: "user"` (the default) gives user tokens with the prefix `tk_`. `"organization"` gives organization tokens with the prefix `to_`, and needs the `organization` plugin. A new key has core's prefix: the app shows it once, at the create. The create body's `prefix` is accepted and not used.
- `rateLimit` is the window of a new key (core's `tokens.defaultRateLimit`). `timeWindow` takes whole seconds in milliseconds, at most one day. `maxRequests` takes 1 to 100000. With no `rateLimit`, a key gets Better Auth's default of 10 calls a day. `enabled: false` gives no window.
- `defaultPrefix`, and each entry of `authtempo.movedKeyPrefixes`, is a moved prefix (core's `tokens.movedPrefixes`). A bearer with one goes to the hash lookup of the moved keys. Each one takes core's form: a lower-case letter, at most 15 more letters or digits, and `_`. A prefix that starts a core prefix, or that one starts, is refused. The refusal names the app's own option.
- `enableMetadata`, `requireName: true`, the name bounds, `keyExpiration`, and `permissions.defaultPermissions` (a set, not a function) keep Better Auth's rules at the create. Core keeps a name on every token, so `requireName: false` is refused at start. With no `requireName` (Better Auth's default is false), a create with no name answers `NAME_REQUIRED`. `expiresIn` takes whole days in seconds. With no `expiresIn` and no `defaultExpiresIn`, a key never expires, as in Better Auth.
- Refused at start: `enableSessionForAPIKeys: true`, because a key never acts as a session (spec 8.8 item 6). Also refused: `disableKeyHashing: true`, a custom key generator, getter, or validator, and a storage other than the database. So are `requireName: false`, `deferUpdates: true`, `schema`, `startingCharactersConfig.charactersLength`, and `apiKeyHeaders` other than `authorization`. A list of configurations is refused: core keeps one token model. So is a second argument of `apiKey`, as Better Auth 1.7.5's `apiKey(configurations, options)` takes; JavaScript would drop it with no error. `configId`, `defaultKeyLength`, and the prefix bounds are notes.

The server calls are Better Auth's: `api.createApiKey`, `api.verifyApiKey`,
`api.listApiKeys`, `api.getApiKey`, `api.updateApiKey`, `api.deleteApiKey`,
and `api.deleteAllExpiredApiKeys` (through `tempo.api.sweepExpired`). With
`headers` the caller is the session, and the server-only fields answer
`SERVER_ONLY_PROPERTY`. With no headers the body's `userId` is the caller, as
in Better Auth. An organization key with no `permissions` gets `{}`, which
grants nothing. `verifyApiKey` runs `tempo.authenticate`, so it spends one
call of the quota and one of the window. Its codes are Better Auth's:
`INVALID_API_KEY`, `RATE_LIMITED`, `USAGE_EXCEEDED`, and `KEY_DISABLED` for a
moved prefix with no row. The shim cannot tell why such a key has no row. So
the text of that `KEY_DISABLED` names each cause: a revoke, a skip at the
move, or an expiry. Better Auth answered `KEY_EXPIRED` for an expired key.
With `permissions`, it checks the key's own set
after the spend; a key with no set passes no check. So a refused check still
spends one call of the quota and of the window. Better Auth 1.7.5 checks the
set before it spends (dist/index.mjs:1663), so there a refused check costs
nothing. This order is a deviation. Core's resolve checks no set, so the
spend comes first (ruling 42 of plan 12k and its final review). A test pins
the spend of a refused check. `updateApiKey` narrows
only: a wider set or a later expiry answers Better Auth's error for a bad
body. `enabled: false` and a `metadata` change answer `NOT_SUPPORTED`: core
has no disabled token and keeps the metadata of the create. The client has
`authClient.apiKey.create`, `list`, `get`, `update`, and `delete`. A call with
`organizationId` acts on the organization's tokens.

Better Auth 1.7.5 deletes a used-up key at verify: a key with `remaining` 0
and no refill (dist/index.mjs:1668). The shim keeps the row, and each verify
answers `USAGE_EXCEEDED`. So a used-up key counts against core's cap of 50
tokens per user, or 50 live tokens per organization, until its owner deletes
it. Core deletes an expired key at verify, as Better Auth does
(dist/index.mjs:1636). It answers `INVALID_API_KEY`, where Better Auth
answers `KEY_EXPIRED`. A create deletes the owner's expired rows before it
counts. A test pins both rows.

The refill differs at one edge. Better Auth 1.7.5 refills when the time since
the last refill is greater than the interval. Core refills when it is equal or
greater (plan 12k decision 6), so a call at the exact interval acts. Both set
the count to `refillAmount` less the one use. A moved interval rounds up to
whole seconds. A move test pins both sides of the edge.

An answer's `start` holds core's hint, and `prefix` is null. `requestCount` is
0, because core's limiter holds the window. The refill fields are there only
in the answer of the create.

### Cutover of API keys

`moveBetterAuthApiKeys(storage, { names, references, dryRun, movedPrefixes, rateLimitEnabled, statements })`
moves each `apikey` row into core's token table. `rateLimitEnabled` is the
plugin's `rateLimit.enabled` (Better Auth's default is true). With false,
Better Auth skips the window of every key, so the move writes no window. `movedPrefixes` is
`movedKeyPrefixesOf(options)`, the list that core's `tokens.movedPrefixes`
holds. Before any write, and on a dry run too, the move can throw a
`BetterAuthCompatError`. It throws when no entry starts a stored prefix, or
when a row has no prefix. The error names each such prefix and counts the rows with no
prefix (ruling 40 of plan 12k). Such a key could never act after the move,
because only a bearer with a moved prefix reaches the lookup of the moved
keys. Better Auth stores the
SHA-256 of the whole key in base64url, so the digest moves. A moved key acts
under the same secret, with no re-issue (ruling 2 of plan 12k). A row
with `enabled` false, a row past `expiresAt`, and a row whose digest is not
43 base64url characters are skipped. Each moved row gets a record in core's
`ta_moved_token`, in the transaction of its token. A later run skips each
recorded row, so a second run moves nothing, and a revoked key stays revoked
(review finding M2 of Task 12). A run that stops between rows moves the rest
at the next run, each row once. The report
holds counts, owner ids, and the stored prefixes, never a key, a digest, or
metadata. A set loses each resource and action that core's statements do not
know, and `dropped` counts them. A moved row meets core's create rules. A
key with no name gets the name `Moved key`. A name over 80 characters or with
a control character skips as `invalidName`. Metadata whose JSON is over
4096 bytes skips as `invalidMetadata`. A window over one day moves as one
day, with the share of the max that one day holds, rounded down. A window
that core cannot hold without a wider rate skips as `wideWindow`: a stored
max below 1, or a share below 1. An organization key gets its creator from
`metadata.createdByUserId`, else the organization's first owner
(`ownerFallback`). That owner then counts as the creator. The list's
`creatorIsMember` follows that owner, and a removal of that owner with
`revokeTokens: true` revokes these keys too, though the owner never made
them. A moved key acts, so it counts against core's cap of 50
live tokens per owner. An owner with more moved keys can create no new key
until they revoke some. A moved key gets a new id, core's token id, so its `apikey`
id no longer finds it. `ta_moved_token` maps each `apikey` id (`source_id`)
to its token id (`token_id`). Change each app row that holds an old key id
by that map.

Each step is a runbook line, with what breaks without it:

1. Before the cutover, copy the database. Apply the compat migrations to the copy: `storage.migrate()` on Postgres, or the D1 files with `wrangler d1 migrations apply`. Without them, the storage refuses the copy with `schema_mismatch`, and the dry run cannot start. Then run `moveBetterAuthApiKeys` with `dryRun: true` against the copy. On D1, run it in a Worker with the D1 binding, as the compat package README shows. A stored prefix outside `movedPrefixes`, or a row with no prefix, makes the dry run throw `BetterAuthCompatError`. The error names each such prefix and counts the rows with no prefix. Do step 2 for each, and run the dry run again. Else the report gives the count of keys per owner and the stored prefixes. Without it, you do not know whom to tell, or which prefixes to list.
2. Put each stored prefix other than `defaultPrefix` in `authtempo.movedKeyPrefixes`. Re-issue each key with no prefix, and delete its row. Without it, the move throws before its first write and moves nothing. Pass `movedPrefixes: movedKeyPrefixesOf(options)` to the move, so it reads the list that core reads.
3. Tell each owner whose key the report skips. `skippedKeys` names each row id, its owner, and the reason. The reasons are `disabled`, `expired`, `noDigest`, `noCreator`, `noOwner`, `invalidName`, `invalidMetadata`, and `wideWindow`. `noDigest` is a key with no digest. `noCreator` is an organization key with no creator and no owner. `noOwner` is a key whose user or organization is gone. `invalidName` is a name over 80 characters or with a control character. `invalidMetadata` is metadata over 4096 bytes. `wideWindow` is a window that core cannot hold without a wider rate. It has a max below 1, or less than one call a day. A key with no name moves with the name `Moved key`. `present` is a row that an earlier run moved. After the cutover each other skipped key answers 401 `token_retired`, and every script that uses one stops. `verifyApiKey` answers `KEY_DISABLED` for it.
4. Deploy the shim build with the compat migration 0010. Without the migration, the storage refuses to start with `schema_mismatch`. From the deploy to the end of step 5, every old key answers 401 `token_retired`. This gap is an outage of each script with an old key, so keep it short. Run step 5 right after the deploy.
5. Run `moveBetterAuthApiKeys` with `dryRun: false`. On D1, run it in a Worker with the D1 binding, as the compat package README shows. It records each moved row in `ta_moved_token`, so a second run skips it, and a revoked key stays revoked. Without it, every old key answers `token_retired` by its prefix, and the key list shows no row for it.
6. A resource server with `@authtempo/verify` passes `movedPrefixes`, the same list. It passes `movedKind`, with that kind in `accept`: `"api-token"` for `references: "user"`, `"organization-token"` for `"organization"`. Without them, the verifier answers null for every moved key. A new `to_` key needs `"organization-token"` in `accept`.
7. Change the app code that reads the `apikey` table itself, and each check of the old prefix. Without it, a new `to_` key never authenticates, and the key list shows only the old table.
8. When every owner moved, drop the `apikey` table yourself. No migration of authtempo drops it, because it is your record. Without the drop, nothing breaks; the table only holds stale rows.

For consumerb, step 7 is these edits. It lists, reads, and deletes keys
through Drizzle (`routes/api-keys.ts`). It sends a bearer to `verifyApiKey`
only when it starts with `laaa_` (`middleware/identity.ts`). A new key starts
with `to_`, so that check must also take `to_`. The two copies of these
steps, here and on the site's Better Auth guide, are equal, and a site test
holds them so.

#### The move on D1

`moveBetterAuthApiKeys` takes the storage of a D1 binding, so on D1 it runs
in a Worker. This Worker runs steps 1 and 5. Bind the copy of the database
as `DB` for step 1, and the real database for step 5. `./auth.js` is the
app's own module: its `ac`, its apiKey options, and its options of
`betterAuth`. A dry run with a prefix outside the list answers 409 with the
refusals. A test runs this file on the D1 test pool of the package
(`test/d1/move-keys/worker.ts`), and a test holds this copy equal to it.

```ts
import {
  BetterAuthCompatError,
  betterAuthSchemaStorage,
  type D1DatabaseLike,
  moveBetterAuthApiKeys,
  movedKeyPrefixesOf,
} from "@authtempo/compat-better-auth";
import { ac, authOptions, keys } from "./auth.js";

/**
 * Steps 1 and 5 of the key cutover on D1: a Worker with the app's D1 binding
 * `DB`. `POST /move` runs a dry run, and `POST /move?dryRun=false` moves.
 * Put it behind a check that only an operator passes, and delete it after
 * the move.
 */
export default {
  async fetch(request: Request, env: { DB: D1DatabaseLike }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/move")
      return new Response(null, { status: 404 });
    const storage = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
    try {
      const report = await moveBetterAuthApiKeys(storage, {
        names: storage.names,
        references: keys.references ?? "user",
        dryRun: url.searchParams.get("dryRun") !== "false",
        movedPrefixes: movedKeyPrefixesOf(authOptions(env)),
        rateLimitEnabled: keys.rateLimit?.enabled ?? true,
        statements: ac.statements,
      });
      return Response.json(report);
    } catch (error) {
      // A stored prefix outside the list, or a row with no prefix: nothing moved.
      if (error instanceof BetterAuthCompatError)
        return Response.json({ refusals: error.refusals }, { status: 409 });
      throw error;
    }
  },
};
```

## SSO and SCIM

Since plan 12d (Task 14, spec 30), `sso(options)` of `@better-auth/sso` and
`scim(options)` of `@better-auth/scim` map onto core's SSO and SCIM. The shim
reads both packages at 1.7.2 (`BETTER_AUTH_SSO_VERSION` and
`BETTER_AUTH_SCIM_VERSION`). Core keeps its own tables, `ta_sso_connection`,
`ta_sso_domain`, and the SCIM tables of migration 0011. Better Auth's
`ssoProvider` and SCIM tables stay as they are: no migration writes them.

Each provider is a core connection. The connection's label holds the Better
Auth `providerId`, so a `providerId` names one connection. A provider's
domain is a core domain, routed to the connection. Core's manager guard
decides each provider call: an owner of the organization, with a verified
address, a second factor, and a fresh session. A platform operator passes
too. So the owner turns on `twoFactor` before the first register.
Each Better Auth path spends one to four of core's manager calls: core
allows 30 per person in 15 minutes (`sso-manage:user:<userId>`). A register
spends three, and a verify of a domain spends three.

### The sso options

| Option | On core |
| --- | --- |
| `organizationProvisioning.defaultRole` | `defaultRole` of each new connection (`member` or `admin`) |
| `disableImplicitSignUp` | `jit: false` on each new connection |
| `providersLimit` (a number, default 10) | `sso.limits.connectionsPerOrganization` |
| `provisionUser` | `hooks.sso.beforeSignIn`; with `provisionUserOnEveryLogin`, at each sign-in |
| `saml.clockSkew` (whole seconds, at most 300000 ms) | `sso.saml.clockSkewSeconds` |
| `domainVerification.tokenPrefix` | the name of Better Auth's record, `_<prefix>-<providerId>.<domain>` |
| `saml.requireTimestamps`, `saml.maxResponseSize` (at most 262144), `algorithms.onDeprecated: "reject"`, `saml.enableInResponseToValidation: true` | accepted: core is at least as strict |
| `saml.requestTTL`, `saml.maxMetadataSize`, `compatibility.microsoftEntra` | a note at start: core uses its own value, or accepts the Entra shapes always |

`authtempo.ssoDns` is required with `sso`. It is core's `sso.dns`, for
example `[dohCloudflare(fetch), dohGoogle(fetch)]` from `@authtempo/core`.
Every resolver must give the record. Core has no default resolver, and
Better Auth's `node:dns` read is not used.

These options are refused at start. Each message names the option and the
reason.

- `trustEmailVerified: true`: the domain proof is the only proof of an address.
- `domainVerification.enabled: false`: core proves each domain by DNS.
- `saml.allowIdpInitiated: true`, `saml.idpInitiatedCallbackUrl`, and `saml.enableInResponseToValidation: false`: core binds each Response to its request.
- `saml.enableSingleLogout` and the three logout options: core has no SAML single logout.
- The four allowed algorithm lists: core keeps its own list.
- `resolvePrivateKey`: core sends the client secret, so `private_key_jwt` is refused.
- `redirectURI`: core gives each connection its own callback.
- `defaultSSO`: register each provider through `/sso/register`.
- `organizationProvisioning.getRole` and `organizationProvisioning.disabled`: core gives one role per connection, and adds the member at each SSO sign-in.
- `defaultOverrideUserInfo: true`: core keeps the profile of a user that exists.
- `guardProviderMutation` and `resolveUser`: core's manager guard and resolution run, with no app code.
- A `providersLimit` function, and `modelName`, `fields`, and `schema`.

### The provider fields

`/sso/register` and `/sso/update-provider` read each field of a provider.
A field that core has no feature for answers `NOT_SUPPORTED` (501). The
message names the field and the reason. A field of the wrong form answers
`VALIDATION_ERROR` (400). The fields map so:

- `providerId` is the connection's label: letters, digits, `_`, and `-`. `_<prefix>-<providerId>` must fit one DNS label of 63 characters.
- Only the shim writes a label of this form. Through the shim's handler, core's `POST /sso/connections/create` and `POST /sso/connections/update` refuse such a label with `invalid_body` (400). An update also refuses a new label on a connection that holds one. Else a manager of another organization could take a providerId, and its paths would answer 404. Give a connection that core's routes make a label with another character, such as a space.
- A call of `auth.tempo.api.sso` does not go through the shim's handler, so nothing refuses its label. Never give `connections.create` or `connections.update` of that api a label of the providerId form. The shim's paths read such a label as a providerId. A second row with the label of a shim provider makes the paths of that provider answer 404.
- `issuer`, `oidcConfig.clientId`, `clientSecret`, and `scopes` map to the connection's `issuer`, `clientId`, `clientSecret` (sealed with the keyring), and `scope`.
- `authorizationEndpoint`, `tokenEndpoint`, and `jwksEndpoint` come together, or none of them, and core reads the discovery document.
- `samlConfig.entryPoint`, `cert` (or `idpMetadata.cert`), `idpMetadata.entityID`, and `idpMetadata.metadata` map to `ssoUrl`, `certificates`, `idpEntityId`, and `idpMetadata`. Pass the metadata XML or the other three, not both.
- `samlConfig.mapping.email` and `name` map to `attributes`. `identifierFormat` takes the persistent NameID format only.
- `domain` is one domain. Better Auth's comma list is refused: register one provider per domain.
- `organizationId` is required: core keeps each connection in an organization.

These provider fields are refused:

- `tokenEndpointAuthentication` other than `client_secret_post` and `client_secret_basic`. Core keeps each of the two as the `tokenEndpointAuthMethod` of the connection. `private_key_jwt` and its key fields are refused.
- `pkce: false`, `userInfoEndpoint`, `overrideUserInfo: true`, and `allowIdpInitiated`.
- A `discoveryEndpoint` other than the issuer's.
- A mapping other than core's claims, and `emailVerified` and `extraFields` of each mapping.
- An encrypted assertion and its keys, `spMetadata`, and `privateKey`.
- `audience`, `callbackUrl`, and `idpInitiatedCallbackUrl`.
- `wantAssertionsSigned: false` and `authnRequestsSigned: true`.
- A SHA-1 algorithm, or another algorithm that core does not verify.
- The single logout services of the IdP metadata.

For a SAML provider, Better Auth's `issuer` is the SP entity id. Core gives
each connection its own SP entity id, and the provider's answer gives it as
`issuer`. Give the IdP the SP metadata of the connection.

### The paths

| Better Auth path | Core route |
| --- | --- |
| `POST /sso/register` | `POST /sso/connections/create`, then `POST /sso/domains/add` and `POST /sso/domains/update` |
| `GET /sso/providers` | `GET /sso/connections` and `GET /sso/domains` of each organization that the caller manages |
| `GET /sso/get-provider?providerId=` | `GET /sso/connections` and `GET /sso/domains` |
| `POST /sso/update-provider` | `POST /sso/connections/update`; a new domain is added and routed, and the old one deleted |
| `POST /sso/delete-provider` | `POST /sso/domains/delete` for each domain of the connection, then `POST /sso/connections/delete` |
| `POST /sso/request-domain-verification` | `GET /sso/domains`: the token is core's challenge |
| `POST /sso/verify-domain` | `POST /sso/domains/verify` with Better Auth's record |
| `POST /sign-in/sso` | `POST /sso/discover`, then the start path of the connection |
| `GET /sso/callback/:providerId` | `GET /sso/:connectionId/callback` |
| `POST /sso/saml2/sp/acs/:providerId` | `POST /sso/:connectionId/acs` |
| `GET /sso/saml2/sp/metadata?providerId=` | `GET /sso/:connectionId/metadata` |
| `/scim/v2/*` | the same paths |

Three paths answer `NOT_SUPPORTED` (501): the shared `GET /sso/callback`,
`/sso/saml2/sp/slo/:providerId`, and `POST /sso/saml2/logout/:providerId`.
Core has no shared callback and no SAML single logout.

Core's start sends the callback of the connection,
`<basePath>/sso/<connectionId>/callback`, as the `redirect_uri`. Register
that URL at the IdP: the register answers it as `redirectURI`.

`signIn.sso` takes `email`, `domain`, `providerId`, or `organizationSlug`,
with `callbackURL`. It answers `{ url, redirect: true }`, where `url` is
core's start path with `next`. `errorCallbackURL`, `newUserCallbackURL`,
`scopes`, `loginHint`, `additionalParams`, and `requestSignUp` answer
`NOT_SUPPORTED`. An `email` or a `domain` asks core's discovery, which
names an OIDC or a SAML connection. The shim takes the connection of that
answer only, so a disabled connection answers 404.

### The domain proof

`request-domain-verification` answers `domainVerificationToken` and
`domainVerificationRecords`, two TXT records. Publish both:

- Better Auth's record, `_<prefix>-<providerId>.<domain>` with the value `_<prefix>-<providerId>=<token>` or the token alone. The shim's `verify-domain` reads it.
- Core's record, `_authtempo-challenge.<domain>` with `authtempo-domain=<token>`. Core's own routes read it.

The verify and the recheck read the connection's label once, and build
Better Auth's record from that read. A label outside the providerId form
gives no record. Core also takes a record name of one DNS label under the
domain only. So the owner of a subdomain never proves the parent domain.

The 30-day recheck asks for core's record, then for Better Auth's. A domain
keeps its claim while either record holds on every resolver. Three failed
rechecks that span 72 hours lose the claim.

### The scim options

Each `connections[].credentials[]` is a bearer of one organization: the
connection's `provisioningDomainId`, else its `id`. The shim keeps the
SHA-256 of each token from `scim()` on, never the token. A bearer that
matches a credential that has not expired runs core's SCIM route as that
credential. Its four scopes map one to one, with all four by default. Its
limit key is `scim:token:<connection id>:<credential id>`, and its audit rows
name that id. Any other bearer goes to core's own SCIM tokens.

Refused at start: `authentication` (a custom verifier), `identity`
(explicit linking), `projection` (code that core cannot run), and
`managedConnections`. Core's SCIM tokens replace managed connections:
`tempo.api.scim.tokens.create` and the `/scim/tokens` routes.

### The copy

`copyBetterAuthSso(auth, { after })` copies Better Auth's rows into core.
`auth` is the shim app on `betterAuthSchemaStorage` or `drizzleAdapter`.
Call it until `next` is null:

```ts
let after: string | null = null;
do {
  const r = await copyBetterAuthSso(auth, { after });
  console.log(r.connections, r.domains, r.scimUsers, r.scimGroups, r.scimGroupMembers);
  console.log(r.skipped, r.changed);
  after = r.next;
} while (after !== null);
```

One call stays under 50 statements on D1, the limit of one Worker invocation
on D1 Free. Each call reads one page and stops before a row whose measured
worst cost does not fit. The writes go through `tempo.api.sso` and
`tempo.api.scim` with the app actor `copy-better-auth-sso`. So core seals
each client secret, and each SCIM user passes the address rule.

- A provider is copied with its domain, routed to the connection. A verified Better Auth domain is pending in core: verify it again, and the published Better Auth record proves it.
- A SAML provider with an `identifierFormat` other than the persistent NameID is not copied. `skipped` holds the reason. Core never changes its format: set the persistent NameID at the directory, then register it again.
- A SCIM user is copied when its address is in a verified domain of the organization. Else `skipped` holds core's SCIM error. Verify the domains first.
- A group is copied with no member, and each member is added by a SCIM PATCH. So a group of any size fits the budget.
- `changed` lists what the owner must do. It names the new `redirectURI` at the IdP and the SP metadata of a SAML connection. It names a domain to verify again.
- A provider keeps its `tokenEndpointAuthentication`: core sends the secret of a `client_secret_basic` provider as HTTP Basic, and of a `client_secret_post` provider in the body.
- A second run copies nothing twice. A connection that holds the `providerId` as its label is `present`. So is a SCIM user with the same `externalId` or `userName`. So is a group with the same `externalId` or `displayName`.
- No token is copied. A static credential stays in the `scim` options. Create a core SCIM token for a managed connection.

## JWT and the OAuth provider

Since plan 9g, core mints JWTs (`/jwks`, `/token`, `api.jwt`) and is an OAuth 2.1 and OIDC provider (`/oauth/*` and `auth.wellKnown`). This package maps none of the Better Auth plugins for them (owner decision of 2026-10-13): `jwt`, `mcp`, `cimd`, `oidc-provider`, and `oauth-provider` are refused at construction, and core's minting is off under the package (`jwtMint: false`), so `/api/auth/jwks` and `/api/auth/token` answer 404.

- To keep the provider, move the app from this package to core's own `createAuth` with `jwtMint` and `oauth`, and mount `auth.wellKnown` at the origin root. Migration 0004 already holds core's four tables.
- The Better Auth `jwks` table (`id`, `publicKey`, `privateKey`, `createdAt`, `expiresAt`, `alg`, `crv` in 1.7.2) is neither read nor written. A JWT that Better Auth issued stops verifying at the cutover, and each OAuth client signs in again: its Better Auth refresh tokens and consents do not carry over.
