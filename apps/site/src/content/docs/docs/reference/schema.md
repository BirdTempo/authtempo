---
title: Schema and migrations
description: The tables of each schema version, the migrations of each adapter, and the rule that refuses an old database.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 7
  - packages/adapter-d1/README.md "Migrations"
  - packages/adapter-postgres/README.md "Migrations"
  - packages/adapter-mysql/README.md "Migrations"
  - packages/adapter-sqlite/README.md "Migrations"
  - packages/core/src/storage/ddl.ts
  - 'packages/compat-better-auth/README.md "Storage: in place on the Better Auth tables"'
---

**For:** an operator who deploys a new core, or a developer who reads the tables.

**What it does:** this page lists the tables that each schema version adds, and how each adapter applies its migrations. Core at version 16 needs the migrations up to `0016_schema_v16`.

## Before you start

- Know your adapter: D1, Postgres, SQLite, MySQL, or the Better Auth tables of the compatibility package. [Choose your stack](/docs/start/) lists the stacks that have a tutorial.

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
| 9 | `0009_schema_v9` | No table. It adds `secret_version` to `ta_totp`, `ta_second_factor`, `ta_verification`, and `ta_jwk`: the version of the app secret that seals or keys the value. Default 1. |
| 10 | `0010_schema_v10` | No table. It adds `fresh_at` to `ta_session`, the field `freshAt` (date, nullable). The field holds the time of the last sign-in or re-authentication. Null is never fresh (plan 12a). |
| 11 | `0011_schema_v11` | `ta_oauth_device`, `ta_oauth_subject`, `ta_oauth_session_client`, `ta_oauth_logout`. It also adds the columns of a confidential client to `ta_oauth_client`, and `parent_id` and `dpop_jkt` to `ta_oauth_token` (plan 12e). |
| 12 | `0012_schema_v12` | `ta_operator_audit`. It also adds the three ban fields to `ta_user` and `actor_id` to `ta_session` (plan 12f). |
| 13 | `0013_schema_v13` | `ta_organization_role`, `ta_team`, `ta_team_member`, `ta_organization_token`, `ta_moved_token`. It also adds `active_team_id` to `ta_session`, `team_ids` to `ta_invitation`, and nine columns to `ta_api_token` (plan 12k). |
| 14 | `0014_schema_v14` | `ta_sso_connection`, `ta_sso_domain`, `ta_scim_token`, `ta_scim_user`, `ta_scim_group`, `ta_scim_group_member` (plan 12d). |
| 15 | `0015_schema_v15` | No table. It makes `email` of `ta_user` nullable, and adds `username`, `display_username`, `phone`, and `is_anonymous` to `ta_user`, and three flags to `ta_passkey` (plan 12i). It adds a nullable `issuer` to `ta_oauth_session_client` and `ta_oauth_logout`: the back-channel sign-out message names the issuer that the client saw (plan 12i Task 18). |
| 16 | `0016_schema_v16` | No table. It adds `proved` to `ta_session`: true when the sign-in of the session proved the account. Core sets it once, at the creation of the session. Only the confirm of a change of address changes it later, to true on the session it keeps. A fill sets it from the user of each live session (plan 12p). |

`SCHEMA_VERSION` of `@authtempo/core` is 16.

Version 9 adds `secret_version` to `ta_totp`, `ta_second_factor`, `ta_verification`, and `ta_jwk` (plan 12b). Its migration is `0009_schema_v9` in both adapters and `0006_compat_schema_v9` in the compatibility package. Every row of today reads as version 1. A Worker at version 8 that still runs after the migration writes the default 1. That is correct while the app has one secret: add a second secret version only after every Worker runs core at version 9.

Version 10 comes from the `0010_schema_v10` migration in both adapters, and from `0007_compat_schema_v10` in the compatibility package. Version 10 adds `ta_session.fresh_at`, the field `freshAt` (plan 12a). It has no default and no fill. A session of version 9 holds null and re-authenticates once before its first sensitive change.

Version 10 also adds five verification purposes. `purpose` is a text column, so they need no DDL.

| Purpose | Identifier | What it holds |
| --- | --- | --- |
| `reauth-otp` | The address | A re-authentication code, with the rules of `email-otp`. |
| `email-change` | The user id, so one user has one live request | A change-of-address link: the SHA-256 hex of the `ec_` token. |
| `email-change-otp` | The user id | A change-of-address code: the data of `email-change`, with the code rules of `email-otp`. |
| `oauth-link-state` | The provider name | The state of a link of a provider: the data of `oauth-state` and the user and session of the start. |
| `account-delete` | The user id, so one user has one live link on Postgres and the memory store | The mailed confirm of an account delete: the SHA-256 hex of the `ad_` token. |

Version 11 comes from the `0011_schema_v11` migration in both adapters, and from `0008_compat_schema_v11` in the compatibility package (plan 12e). Each new NOT NULL column of `ta_oauth_client` has a default, so each client row of version 10 reads as the public client it was:

| Column | Default of a version 10 row |
| --- | --- |
| `auth_method` | `none` |
| `grant_types` | `["authorization_code","refresh_token"]` |
| `credentials_scopes`, `post_logout_redirect_uris` | `[]` |
| `introspect`, `backchannel_logout_session_required`, `dpop_bound` | false |
| `subject_type` | `public` |

Every other new column is nullable and reads null. Version 11 also adds the verification purposes `client-assertion` and `dpop-proof`, which need no DDL. Plan 12e also adds the purpose `oauth-family-end`, the end mark of a refresh family that a reuse or a revoke ended. It needs no DDL either.

Version 12 comes from the `0012_schema_v12` migration in both adapters, and from `0009_compat_schema_v12` in the compatibility package (plan 12f). Each new column is nullable, with no default. A row of version 11 holds null: no ban and no impersonation. On the Better Auth tables, `0009_compat_schema_v12` copies each ban of Better Auth's admin plugin into the three ban columns.

| Field | Column | Type | What it holds |
| --- | --- | --- | --- |
| `user.bannedAt` | `ta_user.banned_at` | date, nullable | When an operator banned the user. Null: no ban (plan 12f, spec 26 item 6). |
| `user.banReason` | `ta_user.ban_reason` | string, nullable | The operator's reason for the ban (plan 12f, spec 26 item 6). |
| `user.banUntil` | `ta_user.ban_until` | date, nullable | The end of the ban. Null with `bannedAt` set: the ban has no end (plan 12f, spec 26 item 6). |
| `session.actorId` | `ta_session.actor_id` | string, nullable | The platform operator who impersonates the user. Null on every other session (plan 12f, spec 26 item 9). |
| `operatorAudit` | `ta_operator_audit` | table | One row per operator act: `actorKind`, `actorId`, `action`, `targetUserId`, `reason`, `data`, `ip`, and `userAgent`, with an index on `target_user_id` and on `actor_id`. Core never updates or deletes a row. The account delete keeps the rows (plan 12f, spec 26 item 8). |

Version 13 comes from the `0013_schema_v13` migration in both adapters, and from `0010_compat_schema_v13` in the compatibility package (plan 12k). Each new column is nullable, with no default and no fill. A row of version 12 holds null: no team, no scope, no window, no quota, and a live token.

| Field | Column | Type | What it holds |
| --- | --- | --- | --- |
| `session.activeTeamId` | `ta_session.active_team_id` | string, nullable | The team the session acts in, of its active organization (plan 12k). |
| `invitation.teamIds` | `ta_invitation.team_ids` | json, nullable | The teams that an accept adds the person to (plan 12k). |
| `apiToken.permissions`, `apiToken.metadata` | `ta_api_token.permissions`, `ta_api_token.metadata` | json, nullable | The statements the token may use, and the app's own data. Null: the rights of the user, and no data (plan 12k). |
| `apiToken.rateLimitSeconds`, `apiToken.rateLimitMax` | `ta_api_token.rate_limit_seconds`, `ta_api_token.rate_limit_max` | integer, nullable | The per-token window. Null: no window (plan 12k). |
| `apiToken.remaining`, `apiToken.refillAmount`, `apiToken.refillSeconds`, `apiToken.lastRefillAt` | `ta_api_token.remaining`, `ta_api_token.refill_amount`, `ta_api_token.refill_seconds`, `ta_api_token.last_refill_at` | integer or date, nullable | The quota and its refill. Null: no quota (plan 12k). |
| `apiToken.retiredAt` | `ta_api_token.retired_at` | date, nullable | The time of the retirement of the token. A retired token never acts. Null: live (plan 12k). |
| `organizationRole` | `ta_organization_role` | table | A role that one organization stored: `organizationId`, `name`, `rank`, and `permissions`, unique on (`organization_id`, `name`) (plan 12k). |
| `team` | `ta_team` | table | A named group of members of one organization, with an index on `organization_id`. A team has no role (plan 12k). |
| `teamMember` | `ta_team_member` | table | One member of one team, unique on (`team_id`, `user_id`). It holds a copy of `organization_id`, so a member removal deletes the person's team rows in one statement (plan 12k). |
| `organizationToken` | `ta_organization_token` | table | A token that an organization owns, unique on `token_hash`. It has no `user_id`, so the account delete keeps it (plan 12k). |
| `movedToken` | `ta_moved_token` | table | One key of another system that a move made a core token: `source`, `sourceId`, and `tokenId`, unique on (`source`, `source_id`). A later move skips a recorded key, so a revoke of its token stays a revoke. The record stays after the revoke (plan 12k). |

Version 14 comes from the `0014_schema_v14` migration in both adapters, and from `0011_compat_schema_v14` in the compatibility package (plan 12d). It adds six tables and changes no table of version 13.

| Field | Column | Type | What it holds |
| --- | --- | --- | --- |
| `ssoConnection` | `ta_sso_connection` | table | One OIDC or SAML connection of one organization, with an index on `organization_id`. The client secret is sealed with the keyring (plan 12d). |
| `ssoDomain` | `ta_sso_domain` | table | One email domain that one organization claims by a DNS proof, unique on (`organization_id`, `domain`) and on `claimed_domain`. The unique index on `claimed_domain` gives one domain at most one claim. Many pending rows can hold a null `claimed_domain` (plan 12d). |
| `scimToken` | `ta_scim_token` | table | A SCIM bearer token of one organization, unique on `token_hash`. It has no `user_id`, so the account delete keeps it (plan 12d). |
| `scimUser` | `ta_scim_user` | table | The SCIM view of one user in one organization, unique on (`organization_id`, `user_id`) and on (`organization_id`, `user_name_key`). It has a `user_id`, so the account delete removes it (plan 12d). |
| `scimGroup` | `ta_scim_group` | table | A SCIM group of one organization, unique on (`organization_id`, `display_name_key`) (plan 12d). |
| `scimGroupMember` | `ta_scim_group_member` | table | One member of one SCIM group, unique on (`group_id`, `scim_user_id`) (plan 12d). |

Version 15 comes from the `0015_schema_v15` migration of D1 and Postgres, from `0003_schema_v15` on MySQL, and from `0012_compat_schema_v15` in the compatibility package (plan 12i). It adds no table. On D1 and SQLite, the migration rebuilds `ta_user`, because SQLite cannot drop NOT NULL. No table refers to `ta_user`, so the rebuild keeps every row and every other table.

| Field | Column | Type | What it holds |
| --- | --- | --- | --- |
| `user.email` | `email` | string, nullable | The address. Null for an account with no address. That is an anonymous account, a phone account, an account of a passkey sign-up, or an account of an `addressless` social entry. Still unique: a null never conflicts (plan 12i). |
| `user.username` | `username` | string, nullable | The username in its stored form: NFKC, then lower case. Unique (plan 12i). |
| `user.displayUsername` | `display_username` | string, nullable | The username in the case that the person typed (plan 12i). |
| `user.phone` | `phone` | string, nullable | The phone number in E.164. Unique. Core stores a phone only after a code proved it (plan 12i). |
| `user.isAnonymous` | `is_anonymous` | boolean | True for an anonymous account. The migration writes false into each row of version 14 (plan 12i). |
| `passkey.discoverable` | `discoverable` | boolean, nullable | The `credProps` answer of the registration: true for a discoverable credential, null when the browser gave none (plan 12i). |
| `passkey.prf` | `prf` | boolean | True when the authenticator said that it supports the PRF extension. Default false (plan 12i). |
| `passkey.largeBlob` | `large_blob` | boolean | True when the authenticator said that it supports the `largeBlob` extension. Default false (plan 12i). |
| `oauthSessionClient.issuer` | `issuer` | string, nullable | The issuer of the ID tokens of the link: the entry of a `baseURL` list where the client got them. Null for a link of version 14 (plan 12i Task 18). |
| `oauthLogout.issuer` | `issuer` | string, nullable | The `issuer` of the link that the row replaced. The back-channel sign-out message names it; null names the primary (plan 12i Task 18). |

Version 16 comes from the `0016_schema_v16` migration of D1 and Postgres, from `0004_schema_v16` on MySQL, and from `0013_compat_schema_v16` in the compatibility package (plan 12p). It adds no table.

| Field | Column | Type | What it holds |
| --- | --- | --- | --- |
| `session.proved` | `ta_session.proved` | boolean | True when the sign-in that made the session proved the account. Core sets it once, at the creation of the session. Only the confirm of a change of address changes it later, to true on the session it keeps. A hook cannot set it. A verified-only action reads it with the user row (plan 12p). |

The column is NOT NULL with the default false. Then the migration sets true on each session whose user has a verified address. So a verified user keeps the powers of each live session. A session of a user with no address, or with an unverified address, reads false. That user signs in again for verified powers. A Worker at version 15 that still runs after the migration writes false into each new session. So deploy core at version 16 at once.

The counts are `integer` on Postgres, as every count of core is, except the passkey `counter` and the TOTP `lastStep`.

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

## SQLite

`applySqliteMigrations(driver)` of `@authtempo/adapter-sqlite` applies the D1 files of `@authtempo/adapter-d1`, copied into the package at build. [Run authtempo on SQLite](/docs/guides/sqlite/) tells the rest.

## MySQL column types

MySQL starts at one baseline migration of the current version. [Run authtempo on MySQL](/docs/guides/mysql/) gives the steps, and its [length bounds](/docs/guides/mysql/#length-bounds) list the width of each key string.

| Field type | MySQL column |
| --- | --- |
| string in `MYSQL_STRINGS` | `VARCHAR(<length>) CHARACTER SET ascii COLLATE ascii_bin`, or the same with `utf8mb4` and `utf8mb4_0900_bin` |
| any other string | `TEXT` |
| boolean | `TINYINT(1)` |
| date | `BIGINT`, the epoch milliseconds |
| json | `JSON` |
| integer | `INT`, or `BIGINT` for the passkey `counter` and the TOTP `lastStep` |

Each table is InnoDB with `utf8mb4` and the binary collation `utf8mb4_0900_bin`, so `=` compares bytes. A site test holds this table equal to `columnType` of `@authtempo/core/ddl`.

## The ddl entry

`@authtempo/core/ddl` holds the one column map of every dialect and the DDL of the schema. The adapters, their shape checks, and `authtempo generate` read it. The shipped D1 and Postgres migrations do not: they are records.

| Export | What it is |
| --- | --- |
| `columnType` | The column type of one field of a model on a dialect. |
| `auxColumnType` | The column type of one column of `ta_meta` or `ta_limit` on a dialect. |
| `schemaDdl` | The statements that make every table, key, and index of the schema on a dialect, then the version row. |
| `RUNNER_TABLES` | The tables that a migration runner makes for its own records: `ta_migrations`. |
| `MYSQL_STRINGS` | The MySQL width of each string field that a key or an index holds, keyed `<model>.<field>`. |
| `MysqlString` | One row of `MYSQL_STRINGS`: the length, the character set, the index prefix, and the reason. |
| `mysqlKeyBytes` | The bytes of a MySQL key over fields of a model. |
| `MYSQL_KEY_LIMIT_BYTES` | 3072, the key limit of InnoDB. |

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
| `0006_compat_schema_v9` | `secret_version` on `ta_totp`, `ta_second_factor`, and `ta_jwk`, and `taSecretVersion` on `verification`, which holds the same field. Default 1. The text names the verification table, so tables with other names take the text of `compatMigration0006Sql`. |
| `0007_compat_schema_v10` | `taFreshAt` on `session`, which holds `freshAt`. No default and no fill. The text names the session table, so tables with other names take the text of `compatMigration0007Sql`. |
| `0008_compat_schema_v11` | The columns and the four tables of version 11, with the same defaults. The text names `ta_` tables only, so it is the same for every naming. |
| `0009_compat_schema_v12` | `taBannedAt`, `taBanReason`, and `taBanUntil` on `user`, `taActorId` on `session`, and `ta_operator_audit`. No default. It copies each ban of the admin plugin (`banned`, `banReason`, `banExpires`) into the ban columns, and skips a row that has `taBannedAt`. The text names the user and session tables, so tables with other names take the text of `compatMigration0009Sql`. |
| `0010_compat_schema_v13` | `activeTeamId` on `session` and `teamId` on `invitation`, the columns of Better Auth's teams option. No default and no fill. On Postgres it adds each column only when it is absent. It creates Better Auth's `organizationRole` when it is absent, and adds `taRank` (default 1) and the unique key on (`organizationId`, `role`). It creates Better Auth's `team` and `teamMember` when they are absent. It adds `teamMember.taOrganizationId` and `taUpdatedAt` with a fill, and the unique key on (`teamId`, `userId`). The `d1-before-1.7` file also adds `team.memberCount` (default 0) and `teamMember.membershipKey` (unique), which the team tables of Better Auth 1.4.21 lack. On Postgres it adds these two columns only when they are absent. On D1, tables that hold `session.activeTeamId` and `invitation.teamId` already take an own 0010 file, applied before `authtempo migrate`. It is the shipped file of its directory without its two `ALTER TABLE ... ADD COLUMN` lines of `session` and `invitation`. The other lines must stay. They create the `organizationRole`, `team`, and `teamMember` tables when they are absent. They add `taRank`, the `ta` columns, and the unique keys, and move the versions. The text names the session, invitation, organization, organizationRole, team, and teamMember tables, so tables with other names take the text of `compatMigration0010Sql`. |
| `0011_compat_schema_v14` | The six tables of version 14. Better Auth's `ssoProvider` table and the tables of its SCIM plugin stay as they are. The text names `ta_` tables only, so it is the same for every naming. |
| `0012_compat_schema_v15` | The columns of Better Auth's username, phone number, and anonymous plugins on `user`. They are `username`, `displayUsername`, `phoneNumber`, `phoneNumberVerified`, and `isAnonymous` (default false), with a unique key on `username` and on `phoneNumber`. On Postgres it adds each column only when it is absent. It adds `taDiscoverable`, `taPrf`, and `taLargeBlob` to `passkey`, and `issuer` to `ta_oauth_session_client` and `ta_oauth_logout`. Better Auth's `user.email` stays NOT NULL. The text names the user and passkey tables, so tables with other names take the text of `compatMigration0012Sql`. |
| `0013_compat_schema_v16` | `taProved` on `session`, which holds `proved`. NOT NULL with the default false. The fill sets true on each session whose user has a verified address. A placeholder address of Better Auth counts as no address. The text names the session and user tables, so tables with other names take the text of `compatMigration0013Sql`. |

On D1, a database made by a Better Auth older than 1.7 uses the folder `d1-before-1.7`. [Better Auth compatibility](/docs/reference/compat-better-auth/) tells the rest.

## Next

- [Upgrades](/docs/operations/upgrades/)
- [Write a storage adapter](/docs/guides/adapter/)
- [Backups](/docs/operations/backups/)
