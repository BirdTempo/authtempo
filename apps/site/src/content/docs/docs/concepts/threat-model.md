---
title: The threat model
description: The attackers that authtempo expects, the assets it guards, and the control that stops each attack.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - README.md "Rules that the code enforces"
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 12"
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
| A person with the password | The password of one account | A session without the second factor. |
| A thief of a session | One session cookie or session token | A longer hold on the account. |
| A claimant | An account that they made with an address that they do not own | The account of the real owner, when the owner proves the address later. |
| A hostile page | A page in the person's browser | A request that the person did not mean, or a code sent to another origin. |
| A reader of a database copy | A copy of the tables | The tokens, the codes, or the secrets in the rows. |

## The controls

- **Hashes at rest.** Core stores the SHA-256 of every token. A clear token appears once, in the answer that creates it. A copy of the tables holds no usable token.
- **Keyed and sealed secrets.** An email code and a backup code are HMAC-SHA256 under the app `secret`. The second factor secret and the private signing keys are sealed with AES-256-GCM under a key from `secret`. A copy of the tables without `secret` opens none of them.
- **Constant time.** Every compare of a secret is constant time. An unknown address runs the same hash work as a wrong password.
- **No account probe.** A magic link request, an email code request, and a reset request answer the same for every address.
- **Limits.** Every flow that a stranger can call has a limit per IP, and most have a limit per address. [Limits](/docs/reference/limits/) lists each key.
- **Bounded guesses.** An email code admits 5 guesses, and an address gets at most 20 codes a day. A second-factor challenge admits 5 guesses, and an account at most 30 a day.
- **Single use.** A magic link, a code, a challenge, and an OAuth code are spent in one conditional update. Two uses race for one row, and one wins.
- **The claim rule.** A proof of an address deletes the credentials of a claimant. [The claim rule](/docs/concepts/claim-rule/) tells how.
- **Trusted origins.** A POST with an `Origin` header outside `trustedOrigins` answers 403. A `next` path must start with `/` and not `//`.
- **No secrets in logs.** A log line holds an event name and ids. It never holds a token, a code, a cookie, an address, or an error message.

## The odds

The odds below assume an owned limiter on D1 or Postgres. The memory limiter multiplies each budget by the number of isolates.

| Guess | One try | One account in a day | One account in a year |
| --- | --- | --- | --- |
| A 6-digit email code | 5 × 10⁻⁶ | 1 × 10⁻⁴ | about 3.6 % |
| A TOTP code, with the password | 1.5 × 10⁻⁵ per challenge | 9 × 10⁻⁵ | about 3.2 % |

An email code of 8 digits divides each figure of its row by 100.

## What stays open

- A person who holds the mailbox signs in without the second factor, by a magic link, an email code, or a reset. The second factor gates the password sign-in only.
- A session JWT and an OAuth access token live to their `exp`. A sign-out does not end them.
- A legacy password hash verifies slower than PBKDF2. The response time shows an address that is not yet migrated.
- Off Workers, a caller can set `cf-connecting-ip`. The app must pass `clientIp`, or every per-IP limit fails open.
- There is no lockout per account. The limits bound the guesses instead.

## Next

- [The claim rule](/docs/concepts/claim-rule/)
- [The race rules](/docs/concepts/races/)
- [Secrets](/docs/operations/secrets/)
