# @authtempo/client

## 0.2.0

### Minor Changes

- 45bcab6: Add `client.organizations.audit.list` and `client.organizations.audit.export`. The list reads one page of `GET /organizations/audit` and answers `{ rows, next }`. Pass `next` as `after` to read the page after it. A 200 with no list of `rows`, or with no `next`, answers `unexpected` with status 200. The export is an async iterator over every row of the query. It reads one page of 100 rows for each request and holds one page at a time. A caller that stops early sends no more requests. A failed page throws its `ClientFailure` after the rows of the pages before it. A 200 that is not a page throws `unexpected` with status 200, so a missing `next` cannot end an export early with no failure. The new types are `OrganizationAuditView` and `OrganizationAuditQuery`.
  
  `client.sso.connections.list` now answers `SsoConnectionListedJSON[]`: each connection with its `status`, as `GET /sso/connections` answers it. `SsoConnectionListedJSON` is `SsoConnectionJSON` with `status`, so code that types a listed connection as `SsoConnectionJSON` still compiles.
- 41ad872: The client knows the core code `statement_not_grantable`, with its text. A role create or update answers it when the `permissions` of a stored role name `audit`.
- ee41ba3: The new config block `limits` changes two rules of the rate limits. Without it, each limit works as before.
  
  `limits.windows` gives a limit family another window, such as `"otp:email": { max: 5 }`. `max` is from 1 to 100000, and `seconds` is from 1 to 86400. Core refuses an unknown family at the start. It also refuses the six families whose window comes from another setting. A higher `max` lets a caller try more.
  
  `limits.noClientIp: "refuse"` ends the shared count of the requests with no client IP. `handle` answers 403 `client_ip_missing` to such a request before any route. An in-process call of `auth.api` with `ip: null` throws at its first per-IP limit.
  
  The client has a text for the new code `client_ip_missing`. The compat error map names it.
- 04792aa: Add `POST /sessions/revoke-all`, `api.session.revokeAll`, and `client.sessions.revokeAll()`. The call ends every session of the user, the caller's own too, in one transaction. It also ends the second-factor challenges and the handoff codes. The trusted devices, the API tokens, and the OAuth grants stay, as with `POST /sessions/revoke-others`. The call needs a fresh session, and it shares the limit key `session-revoke:user` with the two other revoke routes. The answer is `{ ended }`, the count of ended sessions with the caller's own, and the route clears the session cookie. A session JWT of an ended session lives to its `exp`.
  
  `POST /revoke-sessions` and `auth.api.revokeSessions` of the Better Auth compat layer now use this one call. Before, they ended the other sessions and then the caller's session in two calls. A failure of the second call left the caller signed in.
- d64537a: The TOTP setup takes an email code in place of the password. `POST /totp/setup` takes `{ password }` or `{ emailCode }`, exactly one. The code is the code of `POST /reauth/email`, and a right code is spent. `api.totp.setup` takes `{ session, password }` or `{ session, emailCode, ip }`, and `client.totp.setup` takes `{ password }` or `{ emailCode }`. A wrong code answers `invalid_code`, the spent guesses of a code answer `too_many_attempts`, and both write no row. Each try counts on `totp-setup:user`, 5 per 15 minutes, as before.
  
  `totp` no longer needs `password`. With no `password`, the factor stays off by default, so an upgrade turns nothing on. Set `totp: {}` to turn it on: the gate then covers the magic link, the email code, and social, and the setup takes the email code. A config with `totp` and neither `password` nor `emailOtp` is refused at start with a new message. A session alone still sets up no factor: the thief of a session does not read the owner's mailbox.
  
  A proof that the deployment lacks answers `not_found` and counts no try: `password` with no `password` config, and `emailCode` with `emailOtp: false`. The passkey method and the email method still take the password.
  
  The Better Auth compat layer still refuses `allowPasswordless: true`. Its refusal text changes: core asks for a proof at every change of the factor, and a session alone is no proof.
- 4d41f15: Add the SSO setup link. An owner of an organization mints a link and sends it to the IT admin of a customer. The IT admin opens it and fills in drafts: a domain, a connection, and a SCIM token. A test sign-in must pass for the current draft. The IT admin hands back, and the owner reads the preview and activates. Nothing goes live before the activation. The activation sends the `version` of the preview that the owner read. It answers `conflict` when the draft, a domain, or the pending SCIM token changed after that read. The sweep deletes the setup links, setup sessions, and test runs 30 days after they expired. It deletes the pending SCIM token of each deleted link too. It counts the rows in `ssoSetupRows`.
  
  It is off by default. Turn it on with `sso: { setup: {} }`. It needs `sso` and `organizations`. It throws a `ConfigError` at start when `account.notices` is `false`, because the owners learn of a ready setup by a notice. `ttlHours` sets the life of a link from 1 to 168 hours, and the default is 72. `page` replaces the setup page of core. The hook `hooks.sso.setupReady` runs after each handback.
  
  The new routes are `POST /sso/setup-links/create`, `GET /sso/setup-links/list`, `GET /sso/setup-links/get`, `POST /sso/setup-links/revoke`, `POST /sso/setup-links/activate`, `GET /sso/setup`, `POST /sso/setup/open`, `POST /sso/setup/domains/add`, `POST /sso/setup/domains/verify`, `POST /sso/setup/connection`, `POST /sso/setup/scim-token`, `POST /sso/setup/handback`, and `GET /sso/setup/status`. The new codes are `setup_link_invalid`, `setup_link_limit`, and `setup_not_tested`. The new notices are `sso_setup_ready` and `sso_activated`. `GUIDES` holds one typed guide for each of Okta, Entra ID, Google Workspace, generic SAML, and generic OIDC. The client has `sso.setupLinks` and `sso.setup`.
  
  No guide was checked on a real tenant. Each guide shows the date of its read, and a label that the docs do not confirm shows as unconfirmed.
  
  One risk stays. A person who steals a link before the IT admin uses it can fill a draft that names the provider of the thief. If the owner activates it after a quick read of the preview, the thief can sign in. Every owner gets the notice of a ready setup. Read the preview, and ask the IT admin by a second channel before you activate.

### Patch Changes

- Updated dependencies [c79bf6c]
- Updated dependencies [d182103]
- Updated dependencies [e386ff8]
- Updated dependencies [227d5c6]
- Updated dependencies [ee41ba3]
- Updated dependencies [b456151]
- Updated dependencies [bc4768d]
- Updated dependencies [8b3ccc6]
- Updated dependencies [2c2dcbd]
- Updated dependencies [7aa0599]
- Updated dependencies [1a22e8a]
- Updated dependencies [5a0384d]
- Updated dependencies [1b83f8c]
- Updated dependencies [04792aa]
- Updated dependencies [d64537a]
- Updated dependencies [01e1b69]
- Updated dependencies [35325a9]
- Updated dependencies [4d41f15]
  - @authtempo/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @authtempo/core@0.1.1

## 0.1.0

### Minor Changes

- b8b54a4: The types of the password calls follow core's sign-up proof. Each `password.signUp` answer holds `signUpProof`. `password.verifyEmail` and `password.verifyCode` answer `passwordKept`. `password.verifyCode`, `password.resendVerification`, and `password.signIn` take `signUpProof`. A native app passes the proof of its sign-up, or the confirm deletes the password. So a native app confirms by `verifyCode`. A native app's `verifyEmail` call carries no proof cookie, and its answer holds no token. So the app keeps no session and no password.
- 108fbf5: Add the error codes `body_too_large` (413) and `body_busy` (503). Core reads at most the cap of each route of a request body, and refuses a longer body before any parse. The cap is 64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes. A JSON body nested deeper than 16 or with more than 4096 items answers `invalid_body` before the parse. A form body of more than 128 pairs gets the refusal of a bad form before the parse, at the SAML ACS too. A SCIM body nested deeper than 16 or with more than 65536 items answers 400 `invalidSyntax` before the parse. The body reads of the routes with a cap above 64 KiB hold at most 16 MiB at once in one isolate. A read past it answers `body_busy` (503) with `Retry-After`. The compatibility package reads each request body with core's capped reader, at the cap of the core route of the path. Past that cap it answers `PAYLOAD_TOO_LARGE` (413) at its first read. Past the budget of the large reads it answers `SERVICE_UNAVAILABLE` (503). Before its read of an SSO connection write, it runs core's limit of the SSO manager writes of the user. Core counts that write once. Add the error code `body_timeout` (408). A body read above the floor stops when it gets no bytes for 10 s. It also stops when it runs past the time of its cap at 128 KiB per second, at least 10 s. Both answer `body_timeout`. One client holds at most 4 MiB of the budget of the large reads, or the cap of its read when that is more. The compatibility package answers `REQUEST_TIMEOUT` (408). The budget has two halves of 8 MiB that do not lend bytes to each other. The large reads of signed-in users use one half, and every other large read uses the other. One IP holds at most 4 MiB of its half, and a user may hold the cap of its read. A request with no client IP takes no share of its own, and counts in the anonymous half only. A signed-in user runs one large body read at a time, and a second answers `body_busy` (503) before any byte. The large read of a signed-in user must arrive at 256 KiB per second or more, so an SSO connection write gets 32 s. Core allows 6 large reads of one user per hour, on the new limit `sso-large-read:user`, and answers `rate_limited` (429) past it. The compatibility package counts that limit before its own read of an SSO connection write, and core counts the write once. A request with no client IP now takes the 4 MiB share of one IP. One caller with no header cannot fill the anonymous half. `ipKey` gives a text that is not an IP the key `text:` and the text. So no header text takes the key `unknown` of a request with no IP. A SCIM body read that stalls answers 408 in the SCIM error form, not core's JSON form. The Apple callback form post counts on the new limit `social-callback:ip` before its read, and answers `rate_limited` past it. The compatibility package reads each SSO connection write once. It clones a POST body only on the four password paths that read the copy. An SSO connection write whose large read cannot start answers `body_busy` (503) before the limits of its user, and counts on neither. A read cannot start while its user runs one, or while the user half has no room for its declared length. So a client that sends it again after `Retry-After` keeps its writes of the hour. The compatibility package checks the same before its own count. A write with no declared length that starts counts at its start, and can then get `body_busy` at its first chunk. The request event of a SCIM 503 now carries the code `body_busy`. The request events of a SCIM 408 and a SCIM 413 carry `body_timeout` and `body_too_large`. An SSO connection write whose large read takes more than 8 s spends the rest of its user's window of `sso-large-read:user`. It spends at each end of the read: whole, 408, 413 past the cap, a 503 during the read, or a closed socket. The spend lands in the window in which the read ends. Until that window ends, both SSO connection writes of the user answer `rate_limited` (429) before any byte. A write that ends within 8 s spends nothing. The compatibility package spends the same at its own read.
- f9781f3: The two SSO connection writes name their row in the query. `POST /sso/connections/create` takes `organizationId` in its query, and `POST /sso/connections/update` takes `id` in its query. The body holds the other fields, and a body that carries the id answers `invalid_body`. So the manager guard runs before the body read. An account that manages no organization reads no large body: each of its writes to these two routes gets a refusal before any byte. The refusal is the 403 of the manager guard, or an earlier one, such as 401, 503, 429, 400, or 404. `POST /sso/connections/delete` reads its body first, at most 64 KiB, and then runs the manager guard. The client sends the query for you, so `sso.connections.create` and `sso.connections.update` keep their inputs. The compatibility package runs the same guard before its own read of these two paths. Before it reads `/sso/register` or `/sso/update-provider`, it checks that the caller can manage some organization.

### Patch Changes

- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- 48a2484: Core and the client declare vitest as an optional peer dependency. Their conformance kits import vitest, so a kit now loads in the test run of an adapter, a limiter, or an SDK. An app that does not run a kit installs nothing new.
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
