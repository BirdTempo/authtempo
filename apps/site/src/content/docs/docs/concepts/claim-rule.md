---
title: Proof of an address and the claim rule
description: Why an account made with an unproved address is only a claim, and what core deletes when the real owner proves the address.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.2
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.3
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.7
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.9
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.10
  - README.md "Rules that the code enforces"
---

**For:** a developer who must know why core deletes credentials at a sign-in, and when.

**What it does:** this page explains the proof of an address, the claim, and the rule that joins them.

## Before you start

- Read [Sign in with a password](/docs/guides/password/), because a password sign-up makes the most claims.

## The problem

A person can make an account with any address. A password sign-up and a social sign-in with an unverified address both do this. Nothing proves that the person owns the mailbox.

Later the real owner of the address signs in with a magic link. If core kept the first person's password, that person would still sign in to the owner's account.

## A proof and a claim

A proof of an address is an event that shows that the person owns the mailbox:

- A magic link.
- An email code.
- A password reset by link or by code.
- The verify link of a password sign-up.
- A provider that says that the address is verified, with the boolean `true`, for the same address.

An account that a person made with an address that nobody proved is a claim, not an account.

## The rule

When a proof arrives for an unverified user, core runs the claim in the same transaction as the sign-in:

1. It takes the claim. On Postgres and MySQL, this step holds the user row. On D1 and SQLite, it writes a lease row that lives 60 seconds.
2. It deletes the other identities of the user. The proving identity and the `email` identity stay.
3. It deletes the password row, except the row that a verify link confirms.
4. It deletes the passkeys, the pending passkey challenges, and the pending handoff codes.
5. It marks the address verified. The same statement clears the phone of the user. It also clears the username, except at the confirm of the sign-up that named it.
6. It deletes every session, as its last step.

The proof then opens a session for the person who proved the address. The claimant keeps none of the rows that the claim deletes. The owner holds the account. [The session proof](#the-session-proof) tells why no session of the claimant gains a power from the claim.

The claim is final once its last write is done. When the sign-in fails after that point, the address stays verified, and the rows that the claim deleted stay deleted. The flow answers an error and opens no session. On Postgres and MySQL such a failure undoes the whole claim.

Two proofs of one address can arrive at the same time. One claims the user. On D1 the other answers 409 [`conflict`](/docs/reference/errors/#conflict). The flow of a magic link or an email code then mails a new proof of its kind to the address. The verify link mails nothing, because the address is now verified. A JSON caller gets the 409 with a `detail` that says to sign in. The form post of the mail link gets a redirect to the app with `auth_error=conflict`.

## The edges

- A provider's verified address counts only when it equals the user's address. A different verified address links nothing and verifies nothing.
- Core links a social identity to an existing user only when the provider says that the address is verified. Else the sign-in answers [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified).
- A reset of a verified user ends every session, and keeps the passkeys and the social identities. Mail access already grants a reset, so the kept credentials give an attacker nothing more.
- An API token needs a proved session at its creation. A session of a claimant is never proved, so a claimant cannot mint one.
- A passkey needs a proved session at its registration, for the same reason. The claim deletes the passkeys before it marks the address verified.
- An OAuth authorize request and a device approval need a proved session. So a claimant gets no grant that outlives the claim.

## The session proof

Each session row holds a flag, `proved`. Core sets it once, at the creation of the session:

- It is false for an anonymous user.
- For a user with an address, it is the verified flag of that address.
- For any other user, it is true, because a user with no address has nothing to claim.
- A handoff copies the flag of its browser session, and an impersonation takes the state of its target.

Only the confirm of a change of address changes the flag later, to true on the session that it keeps. A `session.beforeCreate` hook cannot set it.

Each verified-only action reads the flag of the caller's session with the user row. The terms of the user row stay as before:

- An API token, a username, a phone add, a profile change, and a change of address need a verified address. A user with no address needs a phone or a passkey that signs in.
- A passkey registration, TOTP and the passkey method of the second factor, a password change, and an OAuth grant need a verified address. A user with no address needs an account that is not anonymous.
- An organization, a team, an invitation, an organization token, SSO, the operator tools, and the start of a social link need a verified address. The email method of the second factor needs one too.

An in-process call that passes a user and no session keeps the rule of the user row. `api.tokens.create`, `api.passkeyRegistrationOptions`, `api.verifyPasskeyRegistration`, `api.totp.setup`, and `api.organizationTokens.create` take the session for this reason.

So a session that came before the proof of its address never gains verified powers. On D1 and SQLite each statement of a claim lands at once. A claimant's session is still live between the mark of the address and the session delete. In that gap the user reads as verified, but the session is not proved. Core refuses its verified-only requests. They leave no token, no change of address, no grant, and no factor. On Postgres and MySQL a request can read the session before the claim's commit and the user after it. The flag refuses that request too.

The claim deletes every row that a sign-in trusts before it marks the address verified. A sign-in that reads the user after that mark finds its row gone, and its guard deletes its own session. A sign-in that read the user before the mark has an unproved session. The session delete at the end of the claim removes it. The first step decides a race of two claims of one user, so a claim that loses there writes nothing. A claim that loses at the mark undoes its deletes.

## Why in one transaction

A claim and a sign-in of the claimant can run at the same moment. Each sign-in that trusts a row of the claim ends its transaction with a guard, for a verified user too. The guard is a conditional update on that row. When the claim deleted or changed that row, the guard matches zero rows. The sign-in then deletes its own new session and answers a failure. [The race rules](/docs/concepts/races/) tell more.

## Next

- [The race rules](/docs/concepts/races/)
- [The threat model](/docs/concepts/threat-model/)
- [Sign in with Google and Apple](/docs/guides/social/)
