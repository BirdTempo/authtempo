---
"@authtempo/core": minor
---

Core exports `holdClaim`, `releaseClaim`, and `ClaimLostError` from its root. `holdClaim` takes the first statement of a claim of a user, for a writer that is no claim, such as the importer. On Postgres and MySQL it is an update of the unverified user row, which holds the row lock until the commit. On D1, the SQLite drivers, and the memory store it creates the claim lease. Unlike a claim, it takes no stale lease, because a claim can run past the life of its lease. `releaseClaim` deletes that lease in the same transaction.

A claim of the user waits for the hold on Postgres and MySQL. On D1 it answers 409 `conflict`. On the SQLite drivers and the memory store it retries after a wait, then answers 409. A lease row of the user, live or stale, throws `ClaimLostError` with `held`. The writer runs no hook between the two calls, because the lease lives 60 seconds. A writer that stops before the release leaves the lease. A claim takes it after 60 seconds, and the sweep deletes it then.
