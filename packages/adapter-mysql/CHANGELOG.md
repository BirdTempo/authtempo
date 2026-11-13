# @authtempo/adapter-mysql

## 0.1.0

### Minor Changes

- 552820d: Breaking: a storage adapter must have two new port calls, `deleteRows` and `keep`. An adapter of your own fails the type check until it adds them.
  
  `deleteRows(model, where)` deletes the rows that match and answers them. A row that another caller removed first is not in the answer. D1, SQLite, and Postgres run one `DELETE … RETURNING`. MySQL reads the ids, reads the rows under their locks by id, and deletes them by id, in one transaction.
  
  `keep()` makes the writes of the open transaction so far final, so a later throw undoes only the later writes. D1, SQLite, and the memory store drop their undo entries so far and answer true. Postgres and MySQL isolate the open transaction, so there it does nothing and answers false. The conformance suite holds both calls on every store, with the option `deleteRowsStatements` for MySQL. The storage of the Better Auth tables answers each row of `deleteRows` in the shape that a read gives.
- 8a8c319: Breaking: schema version 16 adds the boolean `proved` to the session row. A storage adapter of your own stores the field, and the conformance suite holds it.
  
  Apply `0016_schema_v16` on D1, SQLite, and Postgres, or `0004_schema_v16` on MySQL, before you deploy core at version 16. Each adapter refuses a database at version 15.
  
  `proved` is true when the session came after the proof of its address. It is also true when the user has no address and is not anonymous. Core sets it once, at the creation of the session. Only the confirm of a change of address changes it later, to true on the session it keeps. The migration adds the column with the default false. Then it sets true on each session whose user has a verified address. So a verified user keeps the powers of each live session. A session of a user with no address, or with an unverified address, reads false. A user with no address signs in again for verified powers. A user with an unverified address proves it first.
  
  A Worker at version 15 that still runs after the migration writes false into each new session. Such a session of a user with a verified address ends at its next use, so the person signs in again once. So deploy core at version 16 at once.

### Patch Changes

- 0347b96: A claim of an address now takes its first statement, then deletes every row that a sign-in trusts, then marks the address verified. It ends the sessions last. The rows are the identities, the passwords, the passkeys, the passkey challenges, and the handoff codes. So a sign-in that reads the user after the flag finds its row gone and opens no session. A sign-in that read the user before the flag holds an unproved session, and the claim's session delete removes it.
  
  The first statement decides a race of two claims of one user, so a lost claim writes nothing. On Postgres and MySQL it is the hold: an update of the user row while it is unverified, which takes the row lock first. On D1, the SQLite drivers, and the memory store it is the lease: a `claim-lease` verification row of the user. A second claim meets the lease and writes nothing. On D1 a second claim answers 409 `conflict` at once. On the SQLite drivers and the memory store a second claim waits 100 milliseconds before each of its three retries. A retry after the rival ended signs the user in. A retry of a sign-up confirm answers `invalid_token`, or `invalid_code` for a code, because the rival's claim deleted its password row. Else it answers 409 `conflict`. On Postgres and MySQL two proofs at once answer 200 and 200 with one claim. The hold waits, and the loser's retry signs in. A sign-up confirm that loses answers `invalid_token`, or `invalid_code` for a code. The lease lives 60 seconds, and the sweep deletes it then. The next claim takes a stale lease.
  
  The password sign-up, the uniform sign-up, and the social sign-up of a new user read the lease in their claim check, live or stale. Each of them created the user, so each lease of that user comes from a claim that started later. A claim can delete before their password or identity create, so that row never outlives the claim. Core exports that check from its root as `claimNotStarted`.
  
  The storage port gains the flag `isolated`. Postgres and MySQL set it true: the open transaction is isolated, and `keep` answers false in it. D1, the SQLite drivers, and the memory store set it false. The storage of the Better Auth tables takes the value of the adapter under it. The conformance suite holds the flag to `keep`.
  
  On D1 each claim sends one more query, the lease. A claim that takes a stale lease sends three more. The sign-ups above send one more query, the read of the lease.
- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [7762d73]
- Updated dependencies [39e5ca1]
- Updated dependencies [0347b96]
- Updated dependencies [b8b54a4]
- Updated dependencies [e239c83]
- Updated dependencies [28f0699]
- Updated dependencies [b6da6a3]
- Updated dependencies [552820d]
- Updated dependencies [abf1b79]
- Updated dependencies [f82781f]
- Updated dependencies [d9fe45b]
- Updated dependencies [30e85d8]
- Updated dependencies [a1c5ad8]
- Updated dependencies [48a2484]
- Updated dependencies [108fbf5]
- Updated dependencies [8953ed5]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/core@0.1.0
