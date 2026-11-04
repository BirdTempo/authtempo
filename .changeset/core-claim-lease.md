---
"@authtempo/core": minor
"@authtempo/adapter-d1": patch
"@authtempo/adapter-sqlite": patch
"@authtempo/adapter-postgres": patch
"@authtempo/adapter-mysql": patch
"@authtempo/compat-better-auth": patch
---

A claim of an address now takes its first statement, then deletes every row that a sign-in trusts, then marks the address verified. It ends the sessions last. The rows are the identities, the passwords, the passkeys, the passkey challenges, and the handoff codes. So a sign-in that reads the user after the flag finds its row gone and opens no session. A sign-in that read the user before the flag holds an unproved session, and the claim's session delete removes it.

The first statement decides a race of two claims of one user, so a lost claim writes nothing. On Postgres and MySQL it is the hold: an update of the user row while it is unverified, which takes the row lock first. On D1, the SQLite drivers, and the memory store it is the lease: a `claim-lease` verification row of the user. A second claim meets the lease and writes nothing. On D1 a second claim answers 409 `conflict` at once. On the SQLite drivers and the memory store a second claim waits 100 milliseconds before each of its three retries. A retry after the rival ended signs the user in. A retry of a sign-up confirm answers `invalid_token`, because the rival's claim deleted its password row. Else it answers 409 `conflict`. On Postgres and MySQL two proofs at once answer 200 and 200 with one claim. The hold waits, and the loser's retry signs in. The lease lives 60 seconds, and the sweep deletes it then. The next claim takes a stale lease.

The password sign-up, the uniform sign-up, and the social sign-up of a new user read the lease in their claim check, live or stale. Each of them created the user, so each lease of that user comes from a claim that started later. A claim can delete before their password or identity create, so that row never outlives the claim. Core exports that check from its root as `claimNotStarted`, and the importer runs it after its writes of an unverified user.

The storage port gains the flag `isolated`. Postgres and MySQL set it true: the open transaction is isolated, and `keep` answers false in it. D1, the SQLite drivers, and the memory store set it false. The storage of the Better Auth tables takes the value of the adapter under it. The conformance suite holds the flag to `keep`.

On D1 each claim sends one more query, the lease. A claim that takes a stale lease sends three more. The sign-ups above send one more query, the read of the lease.
