---
"@authtempo/core": patch
---

A mailbox proof is final. A claim of an unverified address keeps its writes once its last write is done. When the flow fails after that point, the address stays verified and the claimant holds nothing. The flow still answers its error, and it first runs `user.afterVerify`, `session.afterEnd` with reason `claim`, and `operator.afterAction` for each stop row. On Postgres and MySQL such a failure undoes the whole claim, so no after point runs. Before, on D1 such a failure undid the claim after another proof had read the verified flag. Then a reset could answer 200 and leave the user unverified. After a final claim, an identity that a parallel proof of the same user wrote first counts as present, and the flow signs in.

A session that another request ends during a claim no longer undoes the claim. The claim ends the other sessions, and fires `session.afterEnd` only for the sessions that it ended. Before, on D1 a sign-out at that moment made the flow answer 409 `conflict`.

On D1, a store with a query limit per invocation, a magic link or an email code can lose its claim to another proof. It then answers 409 `conflict` and mails a new proof of the same kind to the address. The mail counts on the per-address mail limit of its kind, so a loop of races sends at most that limit. A failure of that mail leaves the 409 and emits `claim.mail_failed`. A sign-up confirm that loses its claim mails nothing, because the address is verified. Its 409 has a `detail` that says to sign in. A social sign-in and an ID-token sign-in send no mail. The other stores run the claim again, and the flow answers as for a verified user.
