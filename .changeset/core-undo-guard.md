---
"@authtempo/core": minor
---

The storage port gains an optional call, `undoOnlyWhile(model, where)`. Inside a transaction, the undo of each later delete puts its rows back only while a row of `model` matches `where`. D1, the SQLite drivers, and the memory store have it on each transaction. Postgres and MySQL leave it out, because a throw there undoes the whole transaction.

A claim of an address calls it after its lease, with the unverified user as the condition. D1 can apply a write and lose its answer. When the claim's mark of the address lands and its answer is lost, the user stays verified, and no row of the claimant comes back. Before, the undo put back the claimant's password, identities, and passkeys on the verified user. A claim whose mark matches no row met a user that another claim verified first. That claim widens the condition to the user row, so the rows that the other claim kept come back.

The conformance suite holds the call on each store that has it. Its option `undoGuard` holds the call to an adapter.
