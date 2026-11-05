---
"@authtempo/core": minor
---

Core exports `PENDING_PROVIDER_PREFIX` and `isPendingProvider` from its root. An importer writes the identity row of a held user with the provider `pending$<provider>`, and no sign-in finds it. The identity list and the operator user list now skip such a row. An unlink of it answers `not_found`. Before, both lists showed the row, and an app could unlink it.
