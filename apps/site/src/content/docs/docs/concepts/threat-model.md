---
title: The threat model
description: The attackers that authtempo expects, the assets it guards, and the control that stops each attack.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.7
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.8
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 17.2
  - README.md "Rules that the code enforces"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 22
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 12"
  - docs/superpowers/plans/2026-10-14-12b-security-hardening.md "Task 13"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 26
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 31
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 13"
---

**For:** a security reviewer, or a developer who must explain the risks of authtempo to one.

**What it does:** this page states who attacks, what they want, and which control of core stops them.

## Before you start

- Read [Architecture](/docs/concepts/architecture/) for the parts of authtempo.

## The assets

- The sessions, the API tokens, and the access tokens. Each one acts as a person.
- The proof of an address. It decides who owns an account.
- The passwords, the second factor secrets, and the signing keys.
- The mail budget of the app. Each sign-in request can send a mail.

## The attackers

| Attacker | What they hold | What they want |
| --- | --- | --- |
| A stranger on the network | Nothing but the public routes | An account, a guess of a code, or a list of the addresses that have accounts. |
| A person with the password or the mailbox | The password of one account, or its mailbox | A session without the second factor. |
| A thief of a session | One session cookie or session token | A longer hold on the account. |
| A claimant | An account that they made with an address that they do not own | The account of the real owner, when the owner proves the address later. |
| A hostile page | A page in the person's browser | A request that the person did not mean, or a code sent to another origin. |
| A reader of a database copy | A copy of the tables | The tokens, the codes, or the secrets in the rows. |
| A thief of an operator secret | One named operator secret | The users that the scopes of the secret reach. |
| A thief of an operator session | A session of a platform operator | An impersonation, or an act on many users. |

## The controls

- **Hashes at rest.** Core stores the SHA-256 of every token. A clear token appears once, in the answer that creates it. A copy of the tables holds no usable token.
- **Keyed and sealed secrets.** An email code and a backup code are HMAC-SHA256 under the app secret. The second factor secret and the private signing keys are sealed with AES-256-GCM under a key from the app secret. A copy of the tables without the secret opens none of them.
- **Secret versions.** Each keyed or sealed row names the version of the app secret that made it. An operator who follows [Secrets](/docs/operations/secrets/) changes the secret and locks nobody out.
- **A strong secret at start.** `createAuth` refuses a current secret under 32 characters or under an estimate of 100 bits.
- **Constant time.** Every compare of a secret is constant time. An unknown address runs the same hash work as a wrong password.
- **No account probe.** A magic link request, an email code request, and a reset request answer the same for every address.
- **A uniform sign-up.** By default a password sign-up answers `{ sent: true }` for every address. A known address gets a mail, not a second account.
- **The sign-up rule.** `signUp: false` or `"invited"` stops strangers from making accounts. Under `"invited"`, a person must prove the address before a session opens.
- **A captcha.** An app can put a captcha on the flows that send mail or write rows. It runs after the per-IP limit and before the per-email limits.
- **A breach check that fails closed.** An app can refuse a password that a breach exposed. When the check gives no answer, core refuses the password with 503. A throw of the app's own function answers 500.
- **Limits.** Every flow that starts a mail or accepts a guess has a limit per IP, and most have a limit per address. The verify routes of a link, the social callbacks, and the token resolve have no limit, because each checks a token of 32 random bytes. A per-IP limit counts an IPv6 address by its `/64`. [Limits](/docs/reference/limits/) lists each key.
- **Bounded guesses.** An email code admits 5 guesses, and an address gets at most 20 codes a day. A second-factor challenge admits 5 guesses, and an account at most 30 a day.
- **Single use.** A magic link, a code, a challenge, and an OAuth code are spent in one conditional update. Two uses race for one row, and one wins.
- **The claim rule.** A proof of an address deletes the credentials of a claimant. [The claim rule](/docs/concepts/claim-rule/) tells how.
- **Trusted origins.** A POST with an `Origin` header outside `trustedOrigins` answers 403. A `next` path must start with `/` and not `//`.
- **A `__Host-` session cookie.** By default the session cookie is `__Host-tempo_session`. A host on a sibling subdomain cannot set it.
- **An absolute session lifetime.** With `session.absoluteDays`, a session ends that many days after it opened, whatever its refresh.
- **Fetch Metadata.** A page of another site cannot post a form to core: the browser's `Sec-Fetch-Site` header must say the post came from the API's own origin.
- **No provider redirect.** Core follows no redirect on a provider call. A provider endpoint cannot steer a request to an internal address.
- **No secrets in logs.** A log line holds an event name and ids. It never holds a token, a code, a cookie, an address, or an error message.
- **Events with no secret.** An event holds no secret, no credential, no free text, and no limiter key. Each field has a kind, and core drops a field that fails it.
- **No address by default.** An event holds no IP, no user agent, and no email unless `observe.include` turns it on. A hash is HMAC-SHA256 under a key from the app secret. An event never holds a raw email.
- **A last scrub.** Core replaces each secret value of the config with `***` before the buffer, with or without a sink. The scrub covers each string field that a flow passes, and the raw IP and user agent. Core drops a raw IP that is not an IP address. The stamp fields get no scrub: the event name, the level, the time, the trace ids, and the route key. Their kinds check each value. With `observe.trustTraceparent: true`, a client trace id reaches a sink as it is. Each sink of `@authtempo/observe` scrubs again.
- **A client reference, not a URL.** An event names an OAuth client by its `cl_` id, or by `cimd:` and 32 hex of the SHA-256 of its metadata URL.
- **Operator acts with a record.** Each operator act checks its actor, and writes its change and an audit row in one transaction. A named secret holds the scopes of its job only. [Run the operator tools](/docs/guides/operator-tools/) tells how.
- **The operator user guard.** A platform operator acts only from a session that is no impersonation session. The user needs the platform role, a verified address, and a second factor, and the session needs a fresh time. Each failed step answers one code.
- **A ban at every door.** A ban ends the sessions, challenges, handoff codes, and OAuth refresh tokens and codes in its transaction. A session that the call leaves gets refused at each door until the sweep ends it.
- **A bounded impersonation.** An impersonation session can never reach a route of `IMPERSONATION_REFUSED`. That list holds each operator route but the stop, the sign-out, and the re-authentication. It holds each change of a way in, each second-factor route, and the handoff start and continue. It also holds the OAuth authorize, sign-in, device approval, grant revoke, and end-session routes. The organization delete and each member write are in it too: the add, the role change, the removal, and the invitation. [The impersonation](/docs/guides/operator-tools/#the-impersonation) lists each part.
- **An impersonation that the user sees.** The session ends at a fixed time of 5 to 240 minutes, and no refresh moves it. Its session JWT holds `act` with the operator's id. The user's session list marks it, and the user gets a notice mail at each start.

## The odds

The odds below assume an owned limiter on D1 or Postgres. The memory limiter multiplies the per-IP, per-address, and per-user budgets by the number of isolates. The caps per code and per challenge live in the row, and stay global.

| Guess | One code or one challenge | One account in a day | One account in a year |
| --- | --- | --- | --- |
| A 6-digit email code | 5 × 10⁻⁶ | 1 × 10⁻⁴ | about 3.6 % |
| A TOTP code, with the password | 1.5 × 10⁻⁵ per challenge | 9 × 10⁻⁵ | about 3.2 % |
| A 6-digit second factor email code, with the password | 5 × 10⁻⁶ per challenge | 3 × 10⁻⁵ | about 1.1 % |

An email code of 8 digits divides each figure of its row by 100.

## What stays open

- An app that sets `totp.gate.magicLink`, `totp.gate.emailOtp`, or `totp.gate.social` to `false` lets the holder of the mailbox, or of the social account, past the factor. `totp.gate.phone` set to `false` lets the holder of the phone past it.
- The email method is the weakest method. A holder of the mailbox resets the password, signs in with it, and passes the email code. It stops a person with the password and no mailbox.
- A reset of a user with the factor off that races the user's first method enable can keep the reset's session, with the factor on. The password sign-in has the same window. Spec 9 records it.
- A person who lost every method and every backup code needs the operator. [Second factor recovery](/docs/operations/second-factor-recovery/) gives the steps. The operator's check of who the person is must reach the level of the enrollment. A weaker check is an easier path past the factor than the factor itself.
- A person with the password and a session turns the passkey and the email method off with the password alone. TOTP turns off only with a code.
- A session JWT and an OAuth access token live to their `exp`. A sign-out does not end them.
- A ban does not end them either. A session JWT lives up to 15 minutes after a ban by default, and at most 60 with `jwtMint.ttlMinutes`. A resource server that checks the signature alone accepts it. [Ban a user](/docs/operations/ban-a-user/) gives the checks.
- After `sessions.endAll`, the OAuth refresh tokens and the API tokens of every user stay. No tool ends every grant of every user after a breach.
- An impersonation session acts as the user on each route that it can reach, until its fixed end. The app can turn the notice off with `operator.impersonation.notice: false` or `account.notices: false`.
- Core checks no proof of a factor disable. The audit row and `hooks.operator.beforeAction` are the controls.
- Core trusts an app actor. A hole in the app's admin route acts with every scope, and an in-process call counts on no limiter.
- A person with write access to the database can change an audit row. On D1 an act can stay with no row when the Worker stops inside it. `hooks.operator.afterAction` sends each row to a separate system.
- The audit row holds the reason of an act. It is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. So the rule refuses U+0085, a control character, and U+202E, a format character. Show a reason as plain data all the same.
- The account delete keeps the audit rows of the user. Core has no retention rule for them, so the app sets one.
- A legacy password hash verifies slower than PBKDF2. The response time shows an address that is not yet migrated.
- Off Workers, a caller can set `cf-connecting-ip`. The app must pass `clientIp`, or every per-IP limit fails open.
- A uniform sign-up of a new address writes rows, and one of a known address does not. The time of the answer can differ by that work, so core does not claim ASVS 5.0.0 6.3.8 in full.
- With `password.uniformSignUp: false`, a sign-up answers `email_taken` or `email_taken_unverified`, so it shows that an address has an account.
- The PBKDF2 cost stays at 100000 iterations until a measurement on a deployed Worker proves a higher count.
- A call to `auth.api` with no `captchaToken` skips the captcha. A server route that proxies a browser and drops the token turns the captcha off for that flow.
- The timing of the verify-mail resend shows an unverified account.
- Number recycling and SIM swap. A new holder of a phone number signs in with the phone code to the account that holds the number. Core sends no mail to the address of that account at a phone sign-in. The session is fresh, so the routes with the fresh rule open to the new holder. The second factor with `totp.gate.phone` on stops a holder of the number alone.
- A user with no address who moves the phone to a new number gets no notice on any channel. The old number gets no text.
- `api.phone.request` in process sends before it answers, so its time tells whether a number has an account. `POST /phone/request` sends after the answer and does not.
- An API token survives a password reset and a sign-out.
- There is no lockout per account. The limits bound the guesses instead.
- The sink of an app is app code. It can write what it wants, and core cannot see it. A sink that copies events with `include.ip: "raw"` to a third party sends the addresses there. The app owns its sink and its log inventory (ASVS 5.0.0 16.2.3).
- An event can drop. A full buffer and a slow sink lose events, and `observe.dropped` counts them. An isolate that stops before a flush loses its buffer with no count. The audit table, not an event, is the record of an operator act.

## A browser client on another origin

The token endpoint answers a browser on another origin in two cases. In the first, the origin is in a redirect URI of the client that the request names, and the answer allows no credentials. In the second, the origin is in `trustedOrigins`, and the answer allows credentials. Each answer names the exact origin and adds `Vary: Origin`. `POST /oauth/revoke` still answers 403 to a cross-site form post. A refused origin spends no code and no refresh token. Core answers a preflight only for a registered client, read by its id. So a preflight never makes core fetch a URL. The check counts on `oauth-token-origin:ip:<ip>`, 60 per 15 minutes ([Limits](/docs/reference/limits/)). Two risks stay open. A person who registers a client with an origin of their own gets CORS for that client only. It covers only the codes that a person allowed for that client by name. A script on the client's own origin can read the client's tokens, and core cannot see it.

## Next

- [The claim rule](/docs/concepts/claim-rule/)
- [The race rules](/docs/concepts/races/)
- [Secrets](/docs/operations/secrets/)
