---
title: The cutover
description: Move the traffic of an app from its old auth system to authtempo, and know what ends at that moment.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17.1
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 23
  - docs/superpowers/plans/2026-10-14-11f-migration.md "Task 11"
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
4. Run the import as a dry run on the real database, and read every line of the report.
5. Tell the people that they must sign in again, and that a second factor must be set up again.
6. Lower the TTL of each DNS name that the old provider serves, one TTL before the cutover.
7. At the cutover, stop the sign-ins of the old system.
8. Run the import for real. With the compatibility package, deploy the alias instead.
9. Run `authtempo import verify` with the same files. It must exit 0.
10. Switch the app to the API with authtempo.
11. Point each DNS name of the old provider at the API.
12. Sign in once with a known user by each method: the magic link, the password, and each provider.
13. After an import, run it again with the same export. It must write nothing.
14. Watch the log for a day. [Observability](/docs/operations/observability/) lists each line.
15. Keep the old provider up until the old TTL has passed.
16. Remove the old callback URLs at each provider.
17. Remove `password.legacyVerify` when the Cognito users have signed in, or when the migration window ends.

## DNS

Lower the TTL one TTL before the cutover. A resolver that holds the old record sends a sign-in to a system that no longer serves it. Each callback URL at a social provider names the host. So register the new host at each provider first, or the provider refuses the callback.

## Cookies

The session cookie is the one that [Cookies](/docs/reference/cookies/) names. The cookies of the old system stay in each browser until they expire, and they do nothing. When the API and the app are on two origins, set the cookie rule of [Run the app on another origin](/docs/guides/split-origins/). Else the browser sends no session cookie to the API.

## Sessions

No session moves from any source, so every session of the old system ends at the cutover. Expect one sign-in per active person in the first session lifetime. Tell the people before the cutover, so that the sign-in does not surprise them.

## Roll back

- An import path: the old system is unchanged, so point the traffic and the DNS names back at it. The limit: each user and each change made in authtempo since the cutover is lost to the old system. So is a password that a person changed in authtempo.
- The [Better Auth](/docs/migrate/better-auth/) path: point the package names back at Better Auth. The limit: a password row that core rehashed to PBKDF2 does not verify in Better Auth, so that person resets the password. A session of core holds a hash in `session.token`, so Better Auth reads no session, and every person signs in again.
- Cognito with the check: keep the old pool up for the whole migration window. The limit: the check sends each first sign-in to the pool. Without the pool, a user who has not signed in yet cannot sign in with a password.

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
- `authtempo migrate --tables compat` stops on an edited compat file: restore its text, and put the change in a new migration of the app.

## Next

- [Observability](/docs/operations/observability/)
- [Secrets](/docs/operations/secrets/)
- [Choose a migration path](/docs/migrate/)
