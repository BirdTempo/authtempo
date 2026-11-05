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
  - docs/superpowers/plans/2026-11-05-12q-claim-residuals.md "Task 2"
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
3. It deletes the password row. Only the confirm of a sign-up, by link or by code, that carries its proof keeps the row. See [The confirm of a sign-up](#the-confirm-of-a-sign-up).
4. It deletes the passkeys, the pending passkey challenges, and the pending handoff codes.
5. It marks the address verified. The same statement clears the phone of the user. It also clears the username, except at the confirm of the sign-up that named it.
6. It deletes every session, as its last step. [The sessions of a claimant](#the-sessions-of-a-claimant) tells the bound of this step.

The proof then opens a session for the person who proved the address. The claimant keeps none of the rows that the claim deletes. The owner holds the account. [The session proof](#the-session-proof) tells why no session of the claimant gains a power from the claim.

The claim is final once its last write is done. When the sign-in fails after that point, the address stays verified, and the rows that the claim deleted stay deleted. The flow answers an error and opens no session. On Postgres and MySQL such a failure undoes the whole claim.

On D1 a write can land and lose its answer. So a claim can fail after its mark of the address, with no undo entry for the mark. The undo of each delete of a claim puts the row back only while the user is unverified. When the mark stays, no row of the claimant comes back. The claimant's sessions stay, because the claim failed before its session delete. Each one ends at its next use, as [the session proof](#the-session-proof) tells. When the undo reverses the mark, the rows come back with the unverified user, as before the claim. [The race rules](/docs/concepts/races/#what-stays-open) tell what stays open after such a failure.

Two proofs of one address can arrive at the same time. One claims the user. On D1 the other answers 409 [`conflict`](/docs/reference/errors/#conflict). The flow of a magic link or an email code then mails a new proof of its kind to the address. The verify link mails nothing, because the address is now verified. A JSON caller gets the 409 with a `detail` that says to sign in. The form post of the mail link gets a redirect to the app with `auth_error=conflict`.

## The confirm of a sign-up

A password sign-up gives a sign-up proof: 32 random bytes behind `sp_`. The verify row holds their SHA-256. The proof travels two ways:

- The route sets it as the HttpOnly cookie `__Host-tempo_signup`, for every caller. It lives as long as the link or the code.
- The JSON answer holds it as `signUpProof`, for an app that the cookie does not reach. That is a native app with no cookie jar, or an app on another site.

A confirm that carries the proof keeps the password of the sign-up. That is the browser of the sign-up, or an app that sends its copy with the code. The cookie wins over the body.

Any other confirm, by link or by code, is a claim. The claim deletes that password too, and the person who opened the link gets a proved session. The answer says `passwordKept: false`, and the redirect of the link goes to `/?password=set`.

The person then sets a first password through `POST /password/change`, with no current password. The session that the confirm opened is proved and fresh, so the change takes it.

An app on another site than the auth origin uses the code form, and sends `signUpProof` with the code. Its proof cookie is a third-party cookie, and many browsers drop it. Then the link is a claim, and the password goes.

So a claimant who signs up with the owner's address keeps no way in. The owner opens the link in another browser, which holds no proof of that sign-up.

The default config opens no session at a sign-up, so the proof is the only signal of the sign-up's browser. A session of the user does not count.

A new link or code keeps the proof hash only when its request carries the proof of an earlier row of the same sign-up. The resend and a password sign-in that mails a new link or code do this. Each takes the cookie, else the body member `signUpProof`. A proof of another sign-up of the same address keeps nothing.

The username that the sign-up named stays after both kinds of confirm.

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

So a session that came before the proof of its address never gains verified powers. On D1 and SQLite each statement of a claim lands at once. A claimant's session is still there between the mark of the address and the session delete. In that gap the user reads as verified, but the session is not proved. Core refuses each request of that session, as the next paragraph tells. So it leaves no token, no change of address, no grant, and no factor. A claimant's session JWT lives to its `exp`, [as every session JWT does](/docs/concepts/threat-model/#what-stays-open), with `email_verified` false and the owner's account as `sub`. On Postgres and MySQL a request can read the session before the claim's commit and the user after it. The flag refuses that request too.

A session that came before the proof ends at its next use once the proof lands. When a session read finds an unproved session of a user with a verified address, it answers as with no session. So the request gets 401. A read that writes also ends the session, with the reason `claimed`, and `session.afterEnd` fires. A read-only read, such as a server render, ends nothing. The session JWT mint refuses such a session, and `api.jwt.sessionLive` answers false for its `sid`.

Such a session stays after a claim in the gap above, and after a lost D1 answer at the mark. A sign-in by a credential that the claim kept can also read the user before the claim and write its session after it. That session ends at its next use too, and the person signs in again. The confirm of a change of address proves the session that it keeps, so that session lives.

The claim deletes every row that a sign-in trusts before it marks the address verified. A sign-in that reads the user after that mark finds its row gone, and its guard deletes its own session. A sign-in that read the user before the mark has an unproved session. The session delete at the end of the claim removes it. The first step decides a race of two claims of one user, so a claim that loses there writes nothing. A claim that loses at the mark undoes its deletes.

## The sessions of a claimant

A claimant can open many sessions before the owner's proof. `session.maxPerUser` caps the live sessions of one user, 100 by default. A session create past it ends the oldest session, with the reason `capped`. Creates at once can leave more until the next create, as [the limits](/docs/reference/limits/) say.

With a `session.afterEnd` hook, the claim reads the sessions and ends them in chunks of 50, one query per chunk. D1 allows 50 queries in one request. So on D1, SQLite, and the memory store the claim ends at most two chunks. It writes a pending-end row for the rest, as a ban does, with the reason `claimed`.

Each of those sessions is unproved on a verified address, so it ends at its next use, as [the session proof](#the-session-proof) tells. The request gets 401, and an app that reads `auth.session` gets no session. The sweep removes the rest over its runs and fires `session.afterEnd` with `claimed`. The row ends only unproved sessions, so the owner's sessions stay. With no hook, or on Postgres and MySQL, the claim ends every session at once.

## Why in one transaction

A claim and a sign-in of the claimant can run at the same moment. Each sign-in that trusts a row of the claim ends its transaction with a guard, for a verified user too. The guard is a conditional update on that row. When the claim deleted or changed that row, the guard matches zero rows. The sign-in then deletes its own new session and answers a failure. [The race rules](/docs/concepts/races/) tell more.

## Next

- [The race rules](/docs/concepts/races/)
- [The threat model](/docs/concepts/threat-model/)
- [Sign in with Google and Apple](/docs/guides/social/)
