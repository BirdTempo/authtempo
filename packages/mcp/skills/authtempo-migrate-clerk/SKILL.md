---
name: authtempo-migrate-clerk
description: Move the users of Clerk into authtempo through the tools of the authtempo MCP server, with a plan, a review by the person, and one run. Use it when a person moves an app from Clerk to authtempo.
metadata:
  source: /docs/migrate/clerk/
---

# Move the users of Clerk to authtempo

**For:** a coding agent that moves the users of an app from Clerk to authtempo for a person.

**What it does:** you rehearse the import on a copy of the database, and the person reads each report. One real run at the cutover writes the users.

## Before you start

- The authtempo MCP server runs in this project. The export files are inside its root.
- The environment of the server holds the connection string, in `DATABASE_URL` or in the variable of its `--url-env` flag.
- Never put a connection string, a key, or a password in a tool input or in a file.
- The database has the tables of authtempo. Run `authtempo migrate --target postgres` first.

## Steps

1. Call `docs.read` with the path `/docs/migrate/clerk/`. Do its export step with the person.
2. Before the import, set the password check of the page in the API.
3. Call `migrate.plan` with `provider: "clerk"` and `against: "empty"`. Add the inputs `csv`, `users`, `organizations`, and `formats`.
4. Read the report. Fix each refused file or input, and plan again.
5. Ask the person to make a copy of the database, as the phase [Move](/docs/migrate/clerk/#move) of the guide says.
6. Ask the person to start the server again with `--url-env COPY_URL`. If not, `migrate.run` writes the real database before the cutover, and a later change in the old system is lost.
7. Call `migrate.plan` with the same input and `against: "database"`. The answer holds a `plan_id`.
8. Show the whole report to the person. Ask the person to read each line and to say yes.
9. After the yes, call `migrate.run` with the same input, the `plan_id`, and `confirm: true`.
10. Ask the person to run `authtempo import verify` on the copy, as the phase [Verify](/docs/migrate/clerk/#verify) says. It must exit 0.
11. Change each auth call of the app with the table of [The calls](/docs/migrate/clerk/#the-calls).
12. Call `docs.read` with the path `/docs/migrate/cutover/`. Do its steps 1 to 8 with the person.
13. At step 9 of the cutover, ask the person to start the server again on the real database.
14. Call `migrate.plan` with the input of the new export and `against: "database"`. Show the whole report, and ask for a yes.
15. After the yes, call `migrate.run` with the same input, the `plan_id`, and `confirm: true`. This is the one real import.
16. Do steps 10 to 12 of the cutover with the person.
17. Sign in once with a known user and the old password.
18. Do steps 14 to 19 of the cutover with the person.

## If it fails

- The real database holds an earlier import: a change in the old system after it is not carried, and verify does not see it. Each user who changed the password resets it. [One real import](/docs/migrate/cutover/#one-real-import) tells why.
- The answer has `isError` and "no held plan has this id": the plan expired or ran. Plan again against the database.
- The answer has `isError` and "the input differs from the plan": give `migrate.run` the input of the plan.
- The answer has `isError` and "changed since the plan": an export file changed. Plan again.
- The report has `exit` 1: a person must look at a record. [The exit status](/docs/reference/cli/import/#the-exit-status) lists each case.
- [`invalid_credentials`](/docs/reference/errors/#invalid_credentials) after the run: the hash format is not in the seam, or the password is wrong.

## Next

- [The cutover](/docs/migrate/cutover/)
- [authtempo import](/docs/reference/cli/import/)
