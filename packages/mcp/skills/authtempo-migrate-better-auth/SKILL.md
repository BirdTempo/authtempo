---
name: authtempo-migrate-better-auth
description: Run an app written for Better Auth 1.7 on authtempo, on its own tables, through a package alias, with the docs tools of the authtempo MCP server. Use it when a person moves an app from Better Auth to authtempo and keeps its code.
metadata:
  source: /docs/migrate/better-auth/
---

# Move an app from Better Auth to authtempo

**For:** a coding agent that moves the app of a person from Better Auth 1.7 to authtempo, with its code and tables.

**What it does:** the Better Auth package names point at `@authtempo/compat-better-auth`. The code of the app then runs on authtempo, on its own Better Auth tables. No import runs.

## Before you start

- The authtempo MCP server runs in this project.
- An app on Better Auth 1.7, on Postgres through postgres.js or on D1.
- The packages of authtempo in the pnpm workspace of the repo.

## Steps

1. Call `docs.read` with the path `/docs/migrate/better-auth/`. Read the whole page.
2. In the `package.json` of the app, point each Better Auth name at `@authtempo/compat-better-auth`, as step 1 of the page shows.
3. Keep `@authtempo/adapter-d1` and `@authtempo/adapter-postgres` in the list, also for an app on one database.
4. Remove each import that step 3 of the page names. The package does not export them.
5. Start the server once. Change or remove each option that the `BetterAuthCompatError` names.
6. Do the storage step of the page for the database of the app: Postgres or D1.
7. Register the new callback URL at each social provider.
8. Call `docs.read` with the path `/docs/migrate/cutover/`. Do its steps with the person.

## If it fails

- `BetterAuthCompatError` at the start: change each option in its list.
- The error "relation ta_limit already exists": the schema holds the tables of the Postgres adapter. Use a schema without them.
- The error "no such column: issuer" on D1: the 1.7 file ran on older tables. Use the files for tables before 1.7.
- [`invalid_token`](/docs/reference/errors/#invalid_token): a magic link, an invitation, or a delete link from before the cutover. Send it again.

## Next

- [The cutover](/docs/migrate/cutover/)
- [Better Auth compatibility](/docs/reference/compat-better-auth/)
