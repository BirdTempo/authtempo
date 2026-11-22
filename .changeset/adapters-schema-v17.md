---
"@authtempo/core": minor
"@authtempo/adapter-d1": minor
"@authtempo/adapter-postgres": minor
"@authtempo/adapter-mysql": minor
"@authtempo/adapter-sqlite": minor
---

Breaking: schema version 17 adds the enterprise setup. The new models are `ssoSetupLink`, `ssoTestRun`, and `ssoSetupSession`. `ssoConnection` gets `draft`, `version`, and `setupLinkId`. `ssoDomain` gets `setupLinkId`. `scimToken` gets `pending` and `setupLinkId`. A storage adapter of your own stores these models and fields, and the conformance suite holds them.

Apply `0017_schema_v17` on D1, SQLite, and Postgres, or `0005_schema_v17` on MySQL, before you deploy core at version 17. Each adapter refuses a database at version 16.

The migration adds columns and tables and changes no row. `draft` and `pending` have the default false, and `version` has the default 1. So a connection of version 16 reads as no draft at version 1, and a token of version 16 reads as not pending.
