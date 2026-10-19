---
name: authtempo-migrate-workos
description: Move the users of WorkOS into authtempo through the tools of the authtempo MCP server, with a plan, a review by the person, and one run. Use it when a person moves an app from WorkOS to authtempo.
metadata:
  source: /docs/migrate/workos/
---

# Move the users of WorkOS to authtempo

**For:** a coding agent that moves the users of an app from WorkOS to authtempo for a person.

**What it does:** you rehearse the import on a copy of the database, and the person reads each report. One real run at the cutover writes the users.

## Before you start

- The authtempo MCP server runs in this project. The export files are inside its root.
- The environment of the server holds the connection string, in `DATABASE_URL` or in the variable of its `--url-env` flag.
- Never put a connection string, a key, or a password in a tool input or in a file.
- The database has the tables of authtempo. Run `authtempo migrate --target postgres` first.
- No password moves from WorkOS. Each user signs in by a magic link or sets a new password.

## Steps

1. Call `docs.read` with the path `/docs/migrate/workos/`. Do its export step with the person.
2. The export step writes four files: `users`, `identities`, `memberships`, and `organizations`.
3. Call `migrate.plan` with `provider: "workos"` and `against: "empty"`. Add the four file inputs.
4. Give `memberships` and `organizations` together, or neither. Give no `formats` and no `legacy_verify`.
5. Read the report. Fix each refused file or input, and plan again.
6. Ask the person to make a copy of the database, as the phase [Move](/docs/migrate/workos/#move) of the guide says.
7. Ask the person to start the server again with `--url-env COPY_URL`. If not, `migrate.run` writes the real database before the cutover, and a later change in the old system is lost.
8. Call `migrate.plan` with the same input and `against: "database"`. The answer holds a `plan_id`.
9. Show the whole report to the person. Ask the person to read each line and to say yes.
10. After the yes, call `migrate.run` with the same input, the `plan_id`, and `confirm: true`.
11. Ask the person to run `authtempo import verify` on the copy, as the phase [Verify](/docs/migrate/workos/#verify) says. It must exit 0.
12. Change each auth call of the app with the table of [The calls](/docs/migrate/workos/#the-calls).
13. Call `docs.read` with the path `/docs/migrate/cutover/`. Do its steps 1 to 8 with the person.
14. At step 9 of the cutover, ask the person to start the server again on the real database.
15. Call `migrate.plan` with the input of the new export and `against: "database"`. Show the whole report, and ask for a yes.
16. After the yes, call `migrate.run` with the same input, the `plan_id`, and `confirm: true`. This is the one real import.
17. Do steps 10 to 12 of the cutover with the person.
18. Sign in once with a known user by a magic link.
19. Do steps 14 to 19 of the cutover with the person.

## If it fails

- The answer has `isError` and "no held plan has this id": the plan expired or ran. Plan again against the database.
- The answer has `isError` and "the input differs from the plan": give `migrate.run` the input of the plan.
- The answer has `isError` and "changed since the plan": an export file changed. Plan again.
- The answer has `stopped` with "needs the organizations input": the plan has one file of the pair. Give both.
- The report has `exit` 1: a person must look at a record. [The exit status](/docs/reference/cli/import/#the-exit-status) lists each case.
- [`invalid_credentials`](/docs/reference/errors/#invalid_credentials) after the run: no password moved. The user signs in by a magic link, or sets a new password.

## Next

- [The cutover](/docs/migrate/cutover/)
- [authtempo import](/docs/reference/cli/import/)
