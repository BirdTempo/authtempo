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

1. It marks the address verified first. A sign-in of the claimant that runs at the same moment then sees the flag. The same statement clears the phone of the user. It also clears the username, except at the confirm of the sign-up that named it (plan 12i).
2. It deletes the other identities of the user. The proving identity and the `email` identity stay.
3. It deletes the password row, except the row that a verify link confirms.
4. It deletes every session.
5. It deletes the passkeys, the pending passkey challenges, and the pending handoff codes.

The proof then opens a session for the person who proved the address. The claimant holds nothing. The owner holds the account.

The claim is final once its last write is done. When the sign-in fails after that point, the address stays verified, and the claimant still holds nothing. The flow answers an error and opens no session. On Postgres and MySQL such a failure undoes the whole claim.

Two proofs of one address can arrive at the same time. One claims the user. On D1 the other answers 409 [`conflict`](/docs/reference/errors/#conflict). The flow of a magic link or an email code then mails a new proof of its kind to the address. The verify link mails nothing, because the address is now verified. Its answer says to sign in.

## The edges

- A provider's verified address counts only when it equals the user's address. A different verified address links nothing and verifies nothing.
- Core links a social identity to an existing user only when the provider says that the address is verified. Else the sign-in answers [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified).
- A reset of a verified user ends every session, and keeps the passkeys and the social identities. Mail access already grants a reset, so the kept credentials give an attacker nothing more.
- An API token needs a verified address at its creation, so a claimant never holds one.
- A passkey needs a verified address at its registration, for the same reason.
- An OAuth authorize request refuses an unverified user, so no grant outlives a claim.

## Why in one transaction

A claim and a sign-in of the claimant can run at the same moment. Each sign-in of an unverified user ends its transaction with a guard: a conditional update on the row that it trusted. When the claim deleted or changed that row, the guard matches zero rows. The sign-in then deletes its own new session and answers a failure. [The race rules](/docs/concepts/races/) tell more.

## Next

- [The race rules](/docs/concepts/races/)
- [The threat model](/docs/concepts/threat-model/)
- [Sign in with Google and Apple](/docs/guides/social/)
