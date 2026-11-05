---
"@authtempo/core": minor
"@authtempo/adapter-d1": minor
"@authtempo/adapter-postgres": minor
"@authtempo/adapter-mysql": minor
"@authtempo/adapter-sqlite": minor
---

Breaking: schema version 16 adds the boolean `proved` to the session row. A storage adapter of your own stores the field, and the conformance suite holds it.

Apply `0016_schema_v16` on D1, SQLite, and Postgres, or `0004_schema_v16` on MySQL, before you deploy core at version 16. Each adapter refuses a database at version 15.

`proved` is true when the session came after the proof of its address. It is also true when the user has no address and is not anonymous. Core sets it once, at the creation of the session. Only the confirm of a change of address changes it later, to true on the session it keeps. The migration adds the column with the default false. Then it sets true on each session whose user has a verified address. So a verified user keeps the powers of each live session. A session of a user with no address, or with an unverified address, reads false. A user with no address signs in again for verified powers. A user with an unverified address proves it first.

A Worker at version 15 that still runs after the migration writes false into each new session. Such a session of a user with a verified address ends at its next use, so the person signs in again once. So deploy core at version 16 at once.
