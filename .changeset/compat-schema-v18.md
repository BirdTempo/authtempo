---
"@authtempo/compat-better-auth": minor
"@authtempo/cli": minor
---

Compat migration 0015 serves core's schema version 18. It adds `organization_id` to `ta_operator_audit`. It adds `certificate_ends_at`, `expiry_stage`, `expiry_notice_at`, `last_success_at`, `last_failure_at`, and `last_failure_step` to `ta_sso_connection`. It adds `expiry_stage` and `expiry_notice_at` to `ta_scim_token` and `ta_sso_setup_link`. Each new column is nullable with no default, and the migration changes no row. The text names `ta_` tables only, so it is the same for every naming. The new export is `compatMigration0015Sql`.

Apply 0015 before you deploy core at version 18.

The shim refuses a Better Auth `ac` resource named `audit`, as it refuses `apiToken`. Core 18 owns `audit`, the organization audit. Give the app's resource another name.

The role `owner` now holds core's `audit:read`, as core's owner rank does. So an owner reads `GET /organizations/audit`, and each other role gets `forbidden_rank`. A role statement that names `audit` is refused at start.

The CLI knows schema version 18 and compat version 15. `authtempo migrate --target d1 --tables compat` copies 0015, and `authtempo generate` writes the new columns.
