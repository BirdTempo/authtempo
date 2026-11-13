---
title: The cutover
description: Move the traffic of an app from its old auth system to authtempo, and know what ends at that moment.
type: how-to
sources:
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
  - packages/compat-better-auth/migrations/d1/0001_compat_better_auth.sql
sidebar:
  order: 9
---

**For:** an operator who switches an app from its old auth system to authtempo.

**What it does:** this guide lists the work before, at, and after the moment that the app moves.

## Before you start

- Do the guide of your source system: [Choose a migration path](/docs/migrate/).
- Deploy the API with authtempo, with every migration applied. [Upgrades](/docs/operations/upgrades/) tells how.
- Plan a time of low traffic. Every person signs in again once after the cutover. [authtempo import](/docs/reference/cli/import/) tells why: no session moves from any source.

:::caution
Warning: on Better Auth below 1.7.7, upgrade to 1.7.7 or later before the move. Version 1.7.7 fixed a magic link takeover, and the old system stays the rollback target.
:::

## Steps

1. Better Auth only: upgrade Better Auth to 1.7.7 or later.
2. Register the callback URL of authtempo at each social provider. It is `<baseURL><basePath>/social/<provider>/callback`.
3. Keep the old callback URL too, until the cutover ends, where the provider takes a list.
4. Run the import as a dry run on the real database, and read every line of the report. Run the real import on a copy only, as the guide says. [One real import](#one-real-import) tells why.
5. Tell the people that they must sign in again, and that a second factor must be set up again.
6. Lower the TTL of each DNS name that the old provider serves, at least one old TTL before the cutover.
7. At the cutover, stop the sign-ins of the old system.
8. With an import, export again from the old system by the commands of the guide. If not, each sign-up and each change after the first export is lost.
9. Run the import on the new export into the real database, first as a dry run and then for real. This is the one real import into it. With the compatibility package, deploy the alias instead.
10. After an import, run [`authtempo import verify`](/docs/reference/cli/import/#verify) on the new export. It must exit 0. On D1, run the Worker with a verify bundle.
11. Switch the app to the API with authtempo.
12. Point each DNS name of the old provider at the API.
13. Sign in once with a known user by each method: the magic link, the password, and each provider.
14. After an import, run it again with the new export. It must write nothing.
15. Watch the log for a day. [Observability](/docs/operations/observability/) lists each line.
16. Keep the old provider up until the old TTL has passed. With the Cognito check, keep the pool up until step 19. If the pool stops, each user who has not signed in yet loses the password sign-in.
17. Set the TTL of each DNS name back to its usual value.
18. Remove the old callback URLs at each provider.
19. Remove `password.legacyVerify` when the Cognito users have signed in, or when the migration window ends.

## One real import

The real import into the real database runs once, at step 9, after the old sign-ins stop. The order:

1. Before the cutover, the guide runs the real import and `import verify` on a copy of the database. The real database stays empty.
2. At step 7, the old sign-ins stop. After that, no person changes a password, an address, or an account in the old system.
3. At step 8, the new export holds each change up to that moment.
4. At step 9, the one real import writes the new export into the real database. At step 10, `import verify` reads it.

A real database that holds an earlier import has this limit. The import writes nothing for a user that the database holds by its import id, and `--repair` writes only missing rows. So a password, an address, or a delete that changed in the old system after the earlier import is not carried. `import verify` does not see the change, because it reads that each row exists, not its text, and it exits 0. The old password of such a user still signs in, and the new one does not. The remedy: each user who changed the password after the earlier import resets it.

On Auth0, the hash file comes from a support case, so step 8 cannot export the hashes again. A password that changed after the hash export imports with its old hash, and that user resets the password too.

## DNS

Lower the TTL at least one old TTL before the cutover. A resolver that holds the old record sends a sign-in to a system that no longer serves it. Each callback URL at a social provider names the host. So register the new host at each provider first, or the provider refuses the callback.

## Cookies

The session cookie is the one that [Cookies](/docs/reference/cookies/) names. It is host-only, so a session that the old system shares across subdomains breaks at the cutover. Examples are `advanced.crossSubDomainCookies` of Better Auth and a parent-domain cookie of another provider. After the cutover, server pages on a sibling subdomain see no session, and [Change the calls](/docs/migrate/better-auth/#change-the-calls) tells why. The cookies of the old system stay in each browser until they expire, and authtempo ignores them. When the API and the app are on two origins, set the cookie rule of [Run the app on another origin](/docs/guides/split-origins/). If not, the browser sends no session cookie to the API.

## Sessions

No session moves from any source, so every session of the old system ends at the cutover. Expect one sign-in per active person in the first session lifetime. Tell the people before the cutover, so that the sign-in does not surprise them.

## Roll back

Up to step 11, the app still runs on the old system. Turn the sign-ins of the old system on again, and end the cutover there. Two things changed before step 11:

- An import path: the real database holds the import of step 9. Before the next try, replace it with an empty database at the schema version. If not, the next try meets the limit of [One real import](#one-real-import).
- The compatibility path: step 9 deployed the alias, so the app runs on authtempo from step 9. Roll back as the Better Auth bullets below say.

After step 11, each path has a limit:

- An import path: the old system is unchanged. Point the traffic and the DNS names back at it, and turn its sign-ins on again. If not, nobody can sign in. The limit: each user and each change made in authtempo since the cutover is lost to the old system. So is a password that a person set or changed in authtempo.
- The [Better Auth](/docs/migrate/better-auth/) path: point the package names back at Better Auth. The limit: core writes each password hash in its own format, PBKDF2 by default, at a rehash, a sign-up, a reset, and a change. Better Auth does not verify such a hash, so that person resets the password. Better Auth reads no session that core wrote, so each person who signed in to authtempo signs in again.
- The Better Auth path, before you point back: delete every row of the Better Auth session table. It is `session` by default, or the table of `storage.names.table("session")` when the app gives its own names. This signs every person out of both systems. The compat migration keeps each row from before the cutover with its raw token, and a sign-out in authtempo does not end it. If not, Better Auth accepts each old cookie again until its row expires (7 days by default). This also signs in a person who signed out of authtempo.
- Cognito with the check: keep the old pool up for the whole migration window. The limit: the check sends each first sign-in to the pool. Without the pool, a user who has not signed in yet cannot sign in with a password.
- After step 18: register each old callback URL at its provider again, before you point back. If not, each social sign-in of the old system fails. A GitHub OAuth App holds one callback URL, so set it back to the old URL.

## How it behaves

- Every session of the old system ends. Its tokens do not exist in authtempo.
- A JWT of the old system stops verifying, and each OAuth client of the old system signs in again.
- A pending invitation and a magic link of the old system answer `invalid_token`. Send each invitation again.
- An old password hash verifies until the user's first right sign-in. Until then the response time shows an address that is not yet migrated.
- With the compatibility package, the Better Auth tables stay readable by Better Auth. The `ta` columns are nullable, so a rollback to Better Auth can still write the tables.
- After an import, a rollback to the old system loses each user and each change made in authtempo since the cutover.

:::caution
Warning: a GitHub OAuth App takes one callback URL. Change it at the moment of the cutover, or move to a GitHub App, which takes several.
:::

## If it fails

- [`oauth_failed`](/docs/reference/errors/#oauth_failed) at a social sign-in: the provider does not know the new callback URL.
- [`invalid_token`](/docs/reference/errors/#invalid_token): a link or an invitation from before the cutover. Ask for a new one.
- [`invalid_credentials`](/docs/reference/errors/#invalid_credentials) for many users: the hash formats or the Cognito check are wrong. Stop and read the guide of the source.
- The second import run writes rows: the export changed. Read the report before you go on.
- [`authtempo import verify`](/docs/reference/cli/import/#verify) exits 1: the database does not hold the export. Read the line, then the report, before you switch.
- `authtempo migrate --tables compat` stops on an edited compat file: restore its text, and put the change in a new migration of the app. On tables with other names, apply the app's own compat files with `wrangler d1 migrations apply` first. [authtempo migrate](/docs/reference/cli/migrate/#d1) tells how.

## Next

- [Observability](/docs/operations/observability/)
- [Secrets](/docs/operations/secrets/)
- [Choose a migration path](/docs/migrate/)
