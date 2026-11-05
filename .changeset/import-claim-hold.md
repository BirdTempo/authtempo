---
"@authtempo/import": patch
---

The import of an unverified user, new or repaired, now holds the claim of the user for its writes, through core's `holdClaim`. It takes the hold before its first credential write and releases it before the activation of the password. On Postgres and MySQL a claim of the user waits for the import's commit. On D1 a claim answers 409 `conflict` until the release, and a later claim works. So no claim deletes the claimant's rows before an import write and marks the address verified after it. A claimant who holds the provider account of an imported social identity gets an unproved session, and the owner's claim ends it.

When a claim holds the user first, or verified it before the hold, the import writes no credential. The record is then `partial` with `not repaired: claimed`. On D1 the lease guards only while it lives. So the release deletes only the import's own lease, and it fails when a claim took that lease. After the release, the import checks the user row by its address and flag, for a new user and for a repair. When the release or the check fails, the import deletes the rows it wrote, and the record is `partial` with `not repaired: claimed`. So a claim that verified the user before that check leaves no imported row. After a stall of 60 seconds inside the hold, an imported social identity can be active from its write until that delete.

A run that stops inside the hold leaves the lease on D1. A claim answers 409 for 60 seconds, and then it takes the lease. A repair reports `not repaired: claimed` until the sweep deletes the lease. The app's scheduled sweep deletes the lease at its first run 60 seconds or more after its write. The hold takes no stale lease, because a claim can run past the life of its lease.

On D1 the import of a new unverified user sends six more queries. They are the lease create, the flag read of the hold, the release, and the check. An update in a D1 transaction counts two queries. A repair of an unverified user sends four more, because it keeps its own update of the user row as the check. A verified user sends none more.
