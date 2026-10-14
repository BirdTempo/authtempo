---
title: Schema and migrations
description: The tables of each schema version, the migrations of each adapter, and the rule that refuses an old database.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 7
  - packages/adapter-d1/README.md "Migrations"
  - packages/adapter-postgres/README.md "Migrations"
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
---

**For:** an operator who deploys a new core, or a developer who reads the tables.

**What it does:** this page lists the tables that each schema version adds, and how each adapter applies its migrations. Core at version 8 needs the migrations up to `0008_schema_v8`.

## Before you start

- Know your adapter: D1, Postgres, or the Better Auth tables of the compatibility package. [Choose your stack](/docs/start/) compares them.

## The versions

| Version | Migration | Tables it adds |
| --- | --- | --- |
| 1 | `0001_schema_v1` | `ta_meta`, `ta_user`, `ta_identity`, `ta_session`, `ta_verification`, `ta_passkey` |
| 2 | `0002_schema_v2` | `ta_organization`, `ta_member`, `ta_invitation` |
| 3 | `0003_schema_v3` | `ta_limit`, and an index on the active organization of a session |
| 4 | `0004_schema_v4` | `ta_password` |
| 5 | `0005_schema_v5` | `ta_api_token` |
| 6 | `0006_schema_v6` | `ta_totp`, `ta_trusted_device` |
| 7 | `0007_schema_v7` | `ta_jwk`, `ta_oauth_client`, `ta_oauth_consent`, `ta_oauth_token` |
| 8 | `0008_schema_v8` | `ta_second_factor` (copies each enabled `ta_totp` row with the same id, and deletes each `ta_totp` setup that no enable confirmed) |

`SCHEMA_VERSION` of `@authtempo/core` is 8.

The table prefix `ta_` and the advisory lock names keep the old product name tempo-auth for compatibility. A change needs a migration.

## The version rule

- Each adapter reads `ta_meta.schema_version` once.
- When the version is older than `SCHEMA_VERSION` or missing, every operation throws `StorageError` with `schema_mismatch` until the migrations run.
- Only a missing `ta_meta` table counts as a missing version. Any other read error passes through, and the next operation reads again.
- Apply each migration before you deploy the core that needs it.

## D1

Point `migrations_dir` at the migrations of the adapter, and apply them with wrangler.

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "my-app",
  "database_id": "<the id of your database>",
  "migrations_dir": "node_modules/@authtempo/adapter-d1/migrations"
}]
```

```sh
pnpm --filter my-app exec wrangler d1 migrations apply my-app --remote
```

## Postgres

`applyPostgresMigrations(sql)` creates `ta_migrations` and runs each migration that it does not list yet, each in its own transaction.

- It is safe on every deploy, also from two replicas at once. Each migration takes an advisory lock and reads the applied names again.
- `MIGRATIONS` exposes the SQL text for review.

## The deploy window of version 8

Warning: a Worker at version 7 still runs between `0008_schema_v8` and the deploy. Its second-factor writes do not reach `ta_second_factor`.

1. Apply `0008_schema_v8`.
2. Deploy core at version 8 at once.
3. Run the three checks below immediately after the deploy.
   - Run them before core at version 8 spends a backup code.
4. Fix each user that a check lists, as the list below the commands tells.

On D1:

```sh
pnpm --filter my-app exec wrangler d1 execute my-app --remote --command "SELECT t.user_id FROM ta_totp t WHERE t.enabled_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ta_second_factor s WHERE s.user_id = t.user_id)"
pnpm --filter my-app exec wrangler d1 execute my-app --remote --command "SELECT s.user_id FROM ta_second_factor s WHERE EXISTS (SELECT 1 FROM json_each(s.methods) WHERE json_each.value = 'totp') AND NOT EXISTS (SELECT 1 FROM ta_totp t WHERE t.user_id = s.user_id AND t.enabled_at IS NOT NULL)"
pnpm --filter my-app exec wrangler d1 execute my-app --remote --command "SELECT s.user_id FROM ta_second_factor s JOIN ta_totp t ON t.id = s.id WHERE s.backup_codes_version = 1 AND t.backup_codes <> s.backup_codes"
```

On Postgres:

```sh
psql "$DATABASE_URL" -c "SELECT t.user_id FROM ta_totp t WHERE t.enabled_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ta_second_factor s WHERE s.user_id = t.user_id)"
psql "$DATABASE_URL" -c "SELECT s.user_id FROM ta_second_factor s WHERE s.methods ? 'totp' AND NOT EXISTS (SELECT 1 FROM ta_totp t WHERE t.user_id = s.user_id AND t.enabled_at IS NOT NULL)"
psql "$DATABASE_URL" -c "SELECT s.user_id FROM ta_second_factor s JOIN ta_totp t ON t.id = s.id WHERE s.backup_codes_version = 1 AND t.backup_codes <> s.backup_codes"
```

- **The first check** lists a TOTP enable in the window: the user has no factor row. Copy the `ta_totp` row with the same id, as `0008_schema_v8` does.
- **The second check** lists a disable in the window: the factor lists `totp` with no enabled `ta_totp` row. Run `api.totp.disable({ userId })`.
- **The third check** lists backup codes spent or replaced in the window. Copy `ta_totp.backup_codes` into the factor row.
- The compatibility migration `0005_compat_schema_v8` has the same window and the same checks.

## The Better Auth tables

The compatibility package keeps the tables of Better Auth 1.7. It adds columns to them, and some tables of core beside them.

| Migration | What it adds |
| --- | --- |
| `0001_compat_better_auth` | `ta_meta` and `ta_limit`, the `ta` columns that Better Auth lacks, and the unique keys that core needs. |
| `0002_compat_schema_v5` | No table. It moves the version to 5. The compatibility package holds no API token. |
| `0003_compat_schema_v6` | `ta_totp` and `ta_trusted_device`. |
| `0004_compat_schema_v7` | The four tables of version 7. |
| `0005_compat_schema_v8` | `ta_second_factor`, with the same copy and the same delete. |

On D1, a database made by a Better Auth older than 1.7 uses the folder `d1-before-1.7`. [Better Auth compatibility](/docs/reference/compat-better-auth/) tells the rest.

## Next

- [Upgrades](/docs/operations/upgrades/)
- [Write a storage adapter](/docs/guides/adapter/)
- [Backups](/docs/operations/backups/)
