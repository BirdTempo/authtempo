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

## The odds

The odds below assume an owned limiter on D1 or Postgres. The memory limiter multiplies the per-IP, per-address, and per-user budgets by the number of isolates. The caps per code and per challenge live in the row, and stay global.

| Guess | One code or one challenge | One account in a day | One account in a year |
| --- | --- | --- | --- |
| A 6-digit email code | 5 × 10⁻⁶ | 1 × 10⁻⁴ | about 3.6 % |
| A TOTP code, with the password | 1.5 × 10⁻⁵ per challenge | 9 × 10⁻⁵ | about 3.2 % |
| A 6-digit second factor email code, with the password | 5 × 10⁻⁶ per challenge | 3 × 10⁻⁵ | about 1.1 % |

An email code of 8 digits divides each figure of its row by 100.

## What stays open

- An app that sets `totp.gate.magicLink`, `totp.gate.emailOtp`, or `totp.gate.social` to `false` lets the holder of the mailbox, or of the social account, past the factor.
- The email method is the weakest method. A holder of the mailbox resets the password, signs in with it, and passes the email code. It stops a person with the password and no mailbox.
- A reset of a user with the factor off that races the user's first method enable can keep the reset's session, with the factor on. The password sign-in has the same window. Spec 9 records it.
- A person who lost every method and every backup code needs the operator. [Second factor recovery](/docs/operations/second-factor-recovery/) gives the steps. The operator's check of who the person is must reach the level of the enrollment. A weaker check is an easier path past the factor than the factor itself.
- A person with the password and a session turns the passkey and the email method off with the password alone. TOTP turns off only with a code.
- A session JWT and an OAuth access token live to their `exp`. A sign-out does not end them.
- A legacy password hash verifies slower than PBKDF2. The response time shows an address that is not yet migrated.
- Off Workers, a caller can set `cf-connecting-ip`. The app must pass `clientIp`, or every per-IP limit fails open.
- A uniform sign-up of a new address writes rows, and one of a known address does not. The time of the answer can differ by that work, so core does not claim ASVS 5.0.0 6.3.8 in full.
- With `password.uniformSignUp: false`, a sign-up answers `email_taken` or `email_taken_unverified`, so it shows that an address has an account.
- The PBKDF2 cost stays at 100000 iterations until a measurement on a deployed Worker proves a higher count.
- A call to `auth.api` with no `captchaToken` skips the captcha. A server route that proxies a browser and drops the token turns the captcha off for that flow.
- The timing of the verify-mail resend shows an unverified account.
- An API token survives a password reset and a sign-out.
- There is no lockout per account. The limits bound the guesses instead.

## A browser client on another origin

The token endpoint answers a browser on another origin only when that origin is in a redirect URI of the client that the request names. The answer names the exact origin, adds `Vary: Origin`, and allows no credentials. A refused origin spends no code and no refresh token. A preflight is answered only for a registered client, read by its id, so a preflight never makes core fetch a URL. The check counts on `oauth-token-origin:ip:<ip>`, 60 per 15 minutes ([Limits](/docs/reference/limits/)). Two risks stay open. A person who registers a client with an origin of their own gets CORS for that client only. It covers only the codes that a person allowed for that client by name. A script on the client's own origin can read the client's tokens, and core cannot see it.

## Next

- [The claim rule](/docs/concepts/claim-rule/)
- [The race rules](/docs/concepts/races/)
- [Secrets](/docs/operations/secrets/)
