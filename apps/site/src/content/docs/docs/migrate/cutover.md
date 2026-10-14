---
title: The cutover
description: Move the traffic of an app from its old auth system to authtempo, and know what ends at that moment.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17.1
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
sidebar:
  order: 9
---

**For:** an operator who switches an app from its old auth system to authtempo.

**What it does:** this guide lists the work before, at, and after the moment that the app moves.

## Before you start

- Do the guide of your source system: [Choose a migration path](/docs/migrate/).
- Deploy the API with authtempo, with every migration applied. [Upgrades](/docs/operations/upgrades/) tells how.
- Plan a time of low traffic. Every person signs in again once after the cutover. [authtempo import](/docs/reference/cli/import/) tells why: no session moves from any source.

## Steps

1. Register the callback URL of authtempo at each social provider. It is `<baseURL><basePath>/social/<provider>/callback`.
2. Keep the old callback URL too, until the cutover ends, where the provider takes a list.
3. Run the import as a dry run on the real database, and read every line of the report.
4. Tell the people that they must sign in again, and that a second factor must be set up again.
5. At the cutover, stop the sign-ins of the old system.
6. Run the import for real. With the compatibility package, deploy the alias instead.
7. Switch the app to the API with authtempo.
8. Sign in once with a known user by each method: the magic link, the password, and each provider.
9. After an import, run it again with the same export. It must write nothing.
10. Watch the log for a day. [Observability](/docs/operations/observability/) lists each line.
11. Remove the old callback URLs at each provider.
12. Remove `password.legacyVerify` when the Cognito users have signed in, or when the migration window ends.

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

## Next

- [Observability](/docs/operations/observability/)
- [Secrets](/docs/operations/secrets/)
- [Choose a migration path](/docs/migrate/)
