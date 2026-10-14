---
title: Backups
description: Back up and restore the tables of authtempo on D1 and on Postgres, and know what a restore brings back.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 7
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
sidebar:
  order: 5
---

**For:** an operator who must restore the data of an API with authtempo after a fault.

**What it does:** this guide makes a backup on each database, restores it, and secures what the restore brings back.

## Before you start

- The name of the D1 database, or the URL of the Postgres database.
- The `secret` of the API at the time of the backup. Keep it beside the backup, in a secret store.

## Steps

1. On D1, note that Time Travel is always on. It goes back 30 days on Workers Paid, and 7 days on Workers Free.
2. Read the bookmark of a time before the fault.

```sh
pnpm exec wrangler d1 time-travel info my-app --timestamp="2026-10-14T09:00:00+00:00"
```

3. Restore the database to that time.

```sh
pnpm exec wrangler d1 time-travel restore my-app --timestamp=1791968400
```

4. For a copy outside Cloudflare, export the database to a SQL file.

```sh
pnpm exec wrangler d1 export my-app --remote --output=./my-app.sql
```

5. On Postgres, dump the database in the custom format, and restore it with `pg_restore`.

```sh
pg_dump -Fc -f my-app.dump "$DATABASE_URL"
pg_restore -d "$RESTORE_URL" my-app.dump
```

6. After a restore, delete every session row, because a restore brings back sessions that ended.

```sh
pnpm exec wrangler d1 execute my-app --remote --command "DELETE FROM ta_session"
psql "$DATABASE_URL" -c "DELETE FROM ta_session"
```

7. With the compatibility package, delete the rows of the table `session` instead.
8. Run `auth.api.sweepExpired()` once.

## How it behaves

- A D1 restore overwrites the database in place.
- A D1 export blocks the other requests to the database while it runs.
- `pg_dump` makes a consistent backup while the database is in use, and blocks no reader and no writer. It dumps one database, and no role.
- A restore brings back each row of its time. That includes sessions that a sign-out deleted, and API tokens that a person revoked.
- A link or a code that a person spent after the backup time is live again until its expiry.
- A restored row that holds a sealed value opens only under the `secret` of its time.

:::caution
Warning: a restore revives revoked API tokens and ended sessions. Do step 6, and ask each person to check their API tokens.
:::

## If it fails

- Every second factor fails after a restore: the API runs with another `secret` than the backup. Use the `secret` of the backup's time.
- Every route answers 500 after a restore: the backup is from an older schema version. Apply the migrations again.
- [`invalid_token`](/docs/reference/errors/#invalid_token) for a link: the restore removed the row of a link that was sent after the backup.

## Next

- [Upgrades and schema versions](/docs/operations/upgrades/)
- [Secrets](/docs/operations/secrets/)
- [Schema and migrations](/docs/reference/schema/)
