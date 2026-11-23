---
"@authtempo/compat-better-auth": minor
"@authtempo/cli": minor
---

Compat migration 0014 serves core's schema version 17. It adds `ta_sso_setup_link`, `ta_sso_test_run`, and `ta_sso_setup_session`. It adds `draft` (default false), `version` (default 1), and `setup_link_id` to `ta_sso_connection`, `setup_link_id` to `ta_sso_domain`, and `pending` (default false) and `setup_link_id` to `ta_scim_token`. It changes no row. The text names `ta_` tables only, so it is the same for every naming. The new export is `compatMigration0014Sql`.

Apply 0014 before you deploy core at version 17.

The CLI knows schema version 17 and compat version 14. `authtempo migrate --target d1 --tables compat` copies 0014, and `authtempo generate` writes the three new models.
