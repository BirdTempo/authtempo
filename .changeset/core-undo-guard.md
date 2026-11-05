---
"@authtempo/core": minor
---

The storage port gains an optional call, `undoOnlyWhile(model, where)`. Inside a transaction, the undo of each later delete puts its rows back only while a row of `model` matches `where`. D1, the SQLite drivers, and the memory store have it on each transaction. Postgres and MySQL leave it out, because a throw there undoes the whole transaction.

A claim of an address calls it after its lease, with the unverified user as the condition. D1 can apply a write and lose its answer. When the claim's mark of the address lands and its answer is lost, the user stays verified, and no row of the claimant comes back. Before, the undo put back the claimant's password, identities, and passkeys on the verified user. A claim whose mark matches no row met a user that another claim verified first. That claim widens the condition to the user row, so the rows that the other claim kept come back.

The conformance suite holds the call on each store that has it. Its option `undoGuard` holds the call to an adapter.

A session made before the proof ends at its next use once the proof lands, with the new reason `claimed`. Each session read finds an unproved session of a user with a verified address. It answers as with no session, so the request gets 401. A read that writes ends the session and fires `session.afterEnd`. The session JWT mint refuses such a session, and `api.jwt.sessionLive` answers false. So after a lost answer at the mark, the claimant keeps no session either. Before, that session could read the account, end the owner's sessions, and delete the account.

`SessionEndReason` gains `claimed`. A sign-in by a credential that the claim kept can read the user before the claim and write its session after it. That session ends at its next use too, and the person signs in again. A Worker of schema version 15 that runs after the migration to version 16 writes unproved sessions. Each one now ends at its next use, so deploy core at version 16 at once.
