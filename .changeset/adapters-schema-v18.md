---
"@authtempo/adapter-d1": minor
"@authtempo/adapter-postgres": minor
"@authtempo/adapter-mysql": minor
"@authtempo/adapter-sqlite": minor
---

Breaking: schema version 18 adds the organization audit and the expiry notices. `operatorAudit` gets `organizationId`. `ssoConnection` gets `certificateEndsAt`, `expiryStage`, `expiryNoticeAt`, `lastSuccessAt`, `lastFailureAt`, and `lastFailureStep`. `scimToken` and `ssoSetupLink` get `expiryStage` and `expiryNoticeAt`. A storage adapter of your own stores these fields, and the conformance suite holds them.

Apply `0018_schema_v18` on D1, SQLite, and Postgres, or `0006_schema_v18` on MySQL, before you deploy core at version 18. Each adapter refuses a database at version 17.

The migration adds nullable columns with no default, and four indexes. It changes no row. A row of version 17 reads null in each new field. An audit row from before version 18 keeps a null `organizationId`, so the organization audit does not show it.
