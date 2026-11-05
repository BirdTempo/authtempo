---
"@authtempo/core": minor
---

The storage port gains an optional call, `undoOnlyWhile(model, where, also)`. Inside a transaction, the undo of each later delete puts its rows back only while a row of `model` matches `where`. When `also` names a second model and where, a row must match it too. D1, the SQLite drivers, and the memory store have it on each transaction. Postgres and MySQL leave it out, because a throw there undoes the whole transaction.

A claim of an address calls it after its lease, with the unverified user as the condition. D1 can apply a write and lose its answer. When the claim's mark of the address lands and its answer is lost, the user stays verified, and no row of the claimant comes back. Before, the undo put back the claimant's password, identities, and passkeys on the verified user. A claim whose mark matches no row met a user that another claim verified first. Its undo keeps the condition, so no row comes back onto the verified user.

On a store with no isolation a claim now calls `keep()` right after its mark of the address. So a failure in its session delete keeps the mark and the deletes. Before, the undo put the mark back first, and then the guard put back the claimant's password. That held even after the owner signed in by a second proof. Now the flow answers 500, and the claim stands. The flow runs none of the after points of the claim then. Each session of the claimant that stays ends at its next use.

The storage port gains a second optional call, `deleteOnlyWhile(model, where, whileModel, whileWhere)`. It deletes the rows that `where` matches only while a row of `whileModel` matches `whileWhere`. The check is a term of the delete statement, so the call sends one statement. D1, the SQLite drivers, and the memory store have it. Postgres and MySQL leave it out, because the hold of a claim orders the claims there.

A claim uses it for each delete before its mark, with the unverified user as the condition. On D1 a claim can run past the life of its lease, and a rival claim can then take the lease and end first. The late deletes then remove nothing, so the owner keeps the rows that the rival kept. Before, the late claim deleted those rows, and its undo put them back. That undo also put back the claimant's password when the late claim had deleted it before the rival's mark.

The undo of a claim's deletes also needs the claim's own lease, by its id and the expiry that it wrote. A claim past its lease can throw while a rival claim is between its deletes and its mark. Before, its undo put back the claimant's password, and the rival's mark kept it. The rival's take of the lease, or the sweep, changes that lease row. So the undo of the late claim now puts back no row.

The conformance suite holds each call on each store that has it. A store whose `isolated` is false must have both calls. Its option `undoGuard` holds both calls to any adapter.

A session made before the proof ends at its next use once the proof lands, with the new reason `claimed`. When a session read finds an unproved session of a user with a verified address, it answers as with no session. So the request gets 401. A read that writes ends the session and fires `session.afterEnd`. The session JWT mint refuses such a session, and `api.jwt.sessionLive` answers false. So after a lost answer at the mark, the claimant keeps no session either. Before, that session could read the account, end the owner's sessions, and delete the account.

`SessionEndReason` gains `claimed`. A sign-in by a credential that the claim kept can read the user before the claim and write its session after it. That session ends at its next use too, and the person signs in again. A Worker of schema version 15 that runs after the migration to version 16 writes unproved sessions. Each one now ends at its next use, so deploy core at version 16 at once.
