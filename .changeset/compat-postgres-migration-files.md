---
"@authtempo/compat-better-auth": patch
---

Ship the Postgres text of each compat migration in `migrations/postgres/`, for the default table names. Each file holds the step that `migrate()` runs on Postgres, so a reader can read each shipped step before a migration.
