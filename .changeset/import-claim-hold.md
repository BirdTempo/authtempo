---
"@authtempo/import": patch
---

The import of an unverified user, new or repaired, now holds the claim of the user for its writes, through core's `holdClaim`. It takes the hold before its first credential write and releases it after the activation of the password. On Postgres and MySQL a claim of the user waits for the import's commit. On D1 a claim answers 409 `conflict` until the release, and a later claim works. So no claim deletes the claimant's rows before an import write and marks the address verified after it. A claimant who holds the provider login of an imported social identity gets an unproved session, and the owner's claim ends it.

When a claim holds the user first, the import writes no credential, and the record is `partial` with `not repaired: claimed`. A repair of an unverified user no longer updates the user row by its address and flag, because the hold covers both. A run that stops inside the hold leaves the lease on D1. Until the sweep deletes it after 60 seconds, a claim answers 409, and a repair reports `not repaired: claimed`.

On D1 the hold adds two queries to the import of a new unverified user: the lease create and its delete. A repair of an unverified user sends the same count as before, because the hold replaces its update of the user row. A verified user sends none more.
