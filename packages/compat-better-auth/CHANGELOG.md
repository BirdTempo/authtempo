# @authtempo/compat-better-auth

## 0.1.0

### Minor Changes

- 552820d: Breaking: a storage adapter must have two new port calls, `deleteRows` and `keep`. An adapter of your own fails the type check until it adds them.
  
  `deleteRows(model, where)` deletes the rows that match and answers them. A row that another caller removed first is not in the answer. D1, SQLite, and Postgres run one `DELETE … RETURNING`. MySQL reads the ids, reads the rows under their locks by id, and deletes them by id, in one transaction.
  
  `keep()` makes the writes of the open transaction so far final, so a later throw undoes only the later writes. D1, SQLite, and the memory store drop their undo entries so far and answer true. Postgres and MySQL isolate the open transaction, so there it does nothing and answers false. The conformance suite holds both calls on every store, with the option `deleteRowsStatements` for MySQL. The storage of the Better Auth tables answers each row of `deleteRows` in the shape that a read gives.
- 48a2484: Export `BETTER_AUTH_RANGE` and `inRange`. The range names the Better Auth versions that the package answers, `>=1.7.7 <1.8.0`. The advisory GHSA-965c-763c-88jm affects Better Auth `>=1.4.0-beta.18 <1.7.7`, so the range starts at 1.7.7. The package manifest holds the same range in `authtempo.betterAuth`.
- b8b54a4: A confirm of a password sign-up keeps the password only with core's sign-up proof, the HttpOnly cookie `__Host-tempo_signup` that the sign-up sets. A confirm from another browser deletes the password. The person then sets a first password through `/password/change`.
  
  The verify-email path of the email code plugin passes the request's cookie to core, and its answer gains `passwordKept`.
  
  `api.signUpEmail` answers the proof as `signUpProof`, a member that Better Auth does not have. A server call has no cookie jar, so the app sets the cookie from it. The answer for a taken address holds a proof of the same form. `api.signInEmail` and `api.sendVerificationEmail` read the cookie from `headers`, so a new verify link keeps the proof.
  
  Breaking: an app that signs up on the server and does not set the cookie loses the password at the confirm.
  
  Breaking: a compat native app, such as an Expo app, loses the sign-up's password at the confirm. The compat client keeps no proof, because its sign-up answer is Better Auth's `{ token, user }`. It has no code confirm either. The person then sets a first password through `/password/change`.
- 762c5c3: Compat migration 0013 serves core's schema version 16. It adds `taProved` to Better Auth's `session` table, NOT NULL with the default false. Then it sets true on each session whose user has a verified address. A placeholder address of Better Auth counts as no address. A session of a user with no address, or with an unverified address, reads false. A user with no address signs in again for verified powers. A user with an unverified address proves it first. The fill also sets true on a session that Better Auth made before the proof of the address. Better Auth 1.7.2 and 1.7.7, read 2026-11-04, end no session when the email verification link proves an address. So the fill makes no session stronger than before.
  
  Apply 0013 before you deploy core at version 16. A verified user's session that a Worker of core 15 writes after 0013 ends at its next use, so the person signs in again. Tables with other names take the text of the new export `compatMigration0013Sql`.
- d9fe45b: Breaking: core's cap of the sessions of one user now holds under the shim. The cap is 100 live sessions of a user, and a sign-in past the cap ends the oldest session of the user. Sign-ins at once can leave more until the next sign-in, as core's changeset says. Better Auth has no cap. The new setting `authtempo.sessionMaxPerUser` maps to core's `session.maxPerUser` and takes 1 to 1000. Another value is refused at start.
- f513359: Breaking: `/sso/delete-provider`, `/sso/request-domain-verification`, `/sso/verify-domain`, and `/sso/get-provider` answer 401 `UNAUTHORIZED` to a caller with no session. The old answer was 404 `NOT_FOUND` for an unknown provider, and 400 `VALIDATION_ERROR` for a request with no `providerId`. Sign in before you call these paths.
  
  Breaking: a ban of the caller's own user answers 400 `YOU_CANNOT_BAN_YOURSELF`, as Better Auth does. The old status was 409. Read 400 for this code.
  
  These four SSO paths read the session before any byte of the body. A caller with no session token, or a malformed one, gets 401 with no storage read. A well-formed token that names no session costs one session lookup before the 401. A signed-in caller still gets 404 for an unknown provider. Each SSO path of the shim reads the session with no write. So core's own route does the due sliding refresh, and the answer carries the renewed session cookie.
  
  The SQLite storage turns the foreign keys on for every driver, so a user delete deletes the user's child rows, as on D1. Then it reads the key back. While the key reads 0, each call answers `config_mismatch`: SQLite ignores the pragma inside an open transaction of the app.
- 108fbf5: Add the error codes `body_too_large` (413) and `body_busy` (503). Core reads at most the cap of each route of a request body, and refuses a longer body before any parse. The cap is 64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes. A JSON body nested deeper than 16 or with more than 4096 items answers `invalid_body` before the parse. A form body of more than 128 pairs gets the refusal of a bad form before the parse, at the SAML ACS too. A SCIM body nested deeper than 16 or with more than 65536 items answers 400 `invalidSyntax` before the parse. The body reads of the routes with a cap above 64 KiB hold at most 16 MiB at once in one isolate. A read past it answers `body_busy` (503) with `Retry-After`. The compatibility package reads each request body with core's capped reader, at the cap of the core route of the path. Past that cap it answers `PAYLOAD_TOO_LARGE` (413) at its first read. Past the budget of the large reads it answers `SERVICE_UNAVAILABLE` (503). Before its read of an SSO connection write, it runs core's limit of the SSO manager writes of the user. Core counts that write once. Add the error code `body_timeout` (408). A body read above the floor stops when it gets no bytes for 10 s. It also stops when it runs past the time of its cap at 128 KiB per second, at least 10 s. Both answer `body_timeout`. One client holds at most 4 MiB of the budget of the large reads, or the cap of its read when that is more. The compatibility package answers `REQUEST_TIMEOUT` (408). The budget has two halves of 8 MiB that do not lend bytes to each other. The large reads of signed-in users use one half, and every other large read uses the other. One IP holds at most 4 MiB of its half, and a user may hold the cap of its read. A request with no client IP takes no share of its own, and counts in the anonymous half only. A signed-in user runs one large body read at a time, and a second answers `body_busy` (503) before any byte. The large read of a signed-in user must arrive at 256 KiB per second or more, so an SSO connection write gets 32 s. Core allows 6 large reads of one user per hour, on the new limit `sso-large-read:user`, and answers `rate_limited` (429) past it. The compatibility package counts that limit before its own read of an SSO connection write, and core counts the write once. A request with no client IP now takes the 4 MiB share of one IP. One caller with no header cannot fill the anonymous half. `ipKey` gives a text that is not an IP the key `text:` and the text. So no header text takes the key `unknown` of a request with no IP. A SCIM body read that stalls answers 408 in the SCIM error form, not core's JSON form. The Apple callback form post counts on the new limit `social-callback:ip` before its read, and answers `rate_limited` past it. The compatibility package reads each SSO connection write once. It clones a POST body only on the four password paths that read the copy. An SSO connection write whose large read cannot start answers `body_busy` (503) before the limits of its user, and counts on neither. A read cannot start while its user runs one, or while the user half has no room for its declared length. So a client that sends it again after `Retry-After` keeps its writes of the hour. The compatibility package checks the same before its own count. A write with no declared length that starts counts at its start, and can then get `body_busy` at its first chunk. The request event of a SCIM 503 now carries the code `body_busy`. The request events of a SCIM 408 and a SCIM 413 carry `body_timeout` and `body_too_large`. An SSO connection write whose large read takes more than 8 s spends the rest of its user's window of `sso-large-read:user`. It spends at each end of the read: whole, 408, 413 past the cap, a 503 during the read, or a closed socket. The spend lands in the window in which the read ends. Until that window ends, both SSO connection writes of the user answer `rate_limited` (429) before any byte. A write that ends within 8 s spends nothing. The compatibility package spends the same at its own read.
- f9781f3: The two SSO connection writes name their row in the query. `POST /sso/connections/create` takes `organizationId` in its query, and `POST /sso/connections/update` takes `id` in its query. The body holds the other fields, and a body that carries the id answers `invalid_body`. So the manager guard runs before the body read. An account that manages no organization reads no large body: each of its writes to these two routes gets a refusal before any byte. The refusal is the 403 of the manager guard, or an earlier one, such as 401, 503, 429, 400, or 404. `POST /sso/connections/delete` reads its body first, at most 64 KiB, and then runs the manager guard. The client sends the query for you, so `sso.connections.create` and `sso.connections.update` keep their inputs. The compatibility package runs the same guard before its own read of these two paths. Before it reads `/sso/register` or `/sso/update-provider`, it checks that the caller can manage some organization.

### Patch Changes

- a1c5ad8: The D1 adapter has `undoOnlyWhile` on each transaction. The undo of a delete under it is one `INSERT ... SELECT ... WHERE EXISTS` statement, so the check adds no query. A second condition joins the first in that statement, so it adds no query either. It also has `deleteOnlyWhile`, one `DELETE ... AND EXISTS (...) RETURNING` statement, so that check adds no query either. The SQLite adapter runs the same code, so it has the call too. The D1 and SQLite storages of the Better Auth tables also run that code. Their statements build the same guarded insert and the same guarded delete.
- abf1b79: `/sign-in/social` with an ID token takes its list of providers from core. A provider outside that list answers 501 `NOT_SUPPORTED`, and the message names the providers of core's list.
- d4bc280: `toNodeHandler` gives core the request body as a stream with `duplex: "half"`, so the cap of each route bounds the bytes that the route reads. Before, the handler read every body byte into memory before the shim ran. So an anonymous caller on an SSO path got no 401 until the whole body came, and a body of 16 MiB was held whole.
  
  A request that fails, such as one whose client drops the body, now closes its socket and throws nothing. Before, that rejection ended a `node:http` server.
- 28f0699: `listUserAccounts` and `/list-accounts` skip the pending identity row of an import, whose provider is `pending$<provider>`. `unlinkAccount` answers `ACCOUNT_NOT_FOUND` for such a row. The import writes the row under its hold and makes it live after its last check.
- 3f1c11c: Ship the Postgres text of each compat migration in `migrations/postgres/`, for the default table names. Each file holds the step that `migrate()` runs on Postgres, so a reader can read each shipped step before a migration.
- 30e85d8: Better Auth's `createApiKey` with headers now passes the session of the headers to core. So a session made before the proof of its address makes no key. A server call with `userId` and no headers keeps the rule of the user row. The enable of TOTP passes the session to the TOTP setup of core.
- 0347b96: A claim of an address now takes its first statement, then deletes every row that a sign-in trusts, then marks the address verified. It ends the sessions last. The rows are the identities, the passwords, the passkeys, the passkey challenges, and the handoff codes. So a sign-in that reads the user after the flag finds its row gone and opens no session. A sign-in that read the user before the flag holds an unproved session, and the claim's session delete removes it.
  
  The first statement decides a race of two claims of one user, so a lost claim writes nothing. On Postgres and MySQL it is the hold: an update of the user row while it is unverified, which takes the row lock first. On D1, the SQLite drivers, and the memory store it is the lease: a `claim-lease` verification row of the user. A second claim meets the lease and writes nothing. On D1 a second claim answers 409 `conflict` at once. On the SQLite drivers and the memory store a second claim waits 100 milliseconds before each of its three retries. A retry after the rival ended signs the user in. A retry of a sign-up confirm answers `invalid_token`, or `invalid_code` for a code, because the rival's claim deleted its password row. Else it answers 409 `conflict`. On Postgres and MySQL two proofs at once answer 200 and 200 with one claim. The hold waits, and the loser's retry signs in. A sign-up confirm that loses answers `invalid_token`, or `invalid_code` for a code. The lease lives 60 seconds, and the sweep deletes it then. The next claim takes a stale lease.
  
  The password sign-up, the uniform sign-up, and the social sign-up of a new user read the lease in their claim check, live or stale. Each of them created the user, so each lease of that user comes from a claim that started later. A claim can delete before their password or identity create, so that row never outlives the claim. Core exports that check from its root as `claimNotStarted`.
  
  The storage port gains the flag `isolated`. Postgres and MySQL set it true: the open transaction is isolated, and `keep` answers false in it. D1, the SQLite drivers, and the memory store set it false. The storage of the Better Auth tables takes the value of the adapter under it. The conformance suite holds the flag to `keep`.
  
  On D1 each claim sends one more query, the lease. A claim that takes a stale lease sends three more. The sign-ups above send one more query, the read of the lease.
- 49a63d9: Raise the Node floor in `engines` to 22.13. Each of the three packages needs a package with that floor: mcp needs the CLI, compat-better-auth needs the SQLite adapter, and import needs compat-better-auth.
- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- Updated dependencies [a1c5ad8]
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [b8b54a4]
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
- Updated dependencies [db69d5f]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/adapter-d1@0.1.0
  - @authtempo/adapter-sqlite@0.1.0
  - @authtempo/core@0.1.0
  - @authtempo/adapter-postgres@0.1.0
  - @authtempo/client@0.1.0
  - @authtempo/handoff@0.1.0
