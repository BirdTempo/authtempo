---
title: The account with no address
description: Why a user can have no address, which flows make one, and what such a user can and cannot do.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 32
  - docs/superpowers/plans/2026-10-14-12i-sign-in-additions.md "Task 1"
  - packages/core/src/engine/address.ts
---

**For:** an app developer who turns on a sign-in that needs no address, and who reads `user.email`.

**What it does:** this page explains the user whose `email` is `null`: where it comes from, its rules, and its limits.

## Before you start

- The address rules of [Proof of an address and the claim rule](/docs/concepts/claim-rule/).
- The user fields of [The schema](/docs/reference/schema/).

## Where it comes from

From schema version 15, `user.email` is `string | null`. These flows make a user with no address:

- an anonymous sign-in, as in [Anonymous sessions](/docs/guides/anonymous/);
- a phone sign-up with `phone.signUp`, as in [Sign in with a phone code](/docs/guides/phone/);
- a passkey sign-up, as in [Sign up with a passkey](/docs/guides/passkey-sign-up/);
- a social entry that sets `addressless`, such as [Sign in with TikTok](/docs/guides/providers/tiktok/).

No other flow writes a null. The unique key on the address stays, and two users with no address exist side by side on every adapter.

## The rules

- A null claims nothing, and nothing claims a null. The claim rule needs an address to compare.
- Mail and notices skip a user with no address, and write no line for it.
- The sign-up rule takes a null: `signUp: "open"` lets the user in. `"invited"` and `false` answer `sign_up_closed`, because an invitation names an address.
- A session JWT, an ID token, and the userinfo answer omit `email` and `email_verified` for such a user.
- Core never asserts that an address is present. A source test refuses a `!` or an `as string` on an address in core.

## The proved handle

A user has a proved handle when it holds a verified address, a phone that signs in under the `phone` config, or a passkey.

- A user with no address and a proved handle can update the profile, set a username, add a phone, and make an API token.
- It can register a passkey, and turn on TOTP and the passkey method of the second factor, when it is not anonymous.
- It can add an address with `POST /user/change-email` and a fresh session. The proof of the new address then verifies it.
- An anonymous user has no proved handle. Its session is its only key, and `anonymous_refused` holds every way in.

## What it cannot do

- It gets no magic link, no email code, no reset mail, and no notice. Those need an address.
- It cannot accept an invitation to an organization, because the invitation names an address.
- A provider address never links it. A social sign-in finds it by the identity alone.

## Residuals

- No mail can recover such an account. A person who loses the passkey or the phone loses the account. Ask the person to add a second passkey or an address.
- Your own code that reads `user.email` must handle `null`. A TypeScript build with `strict` names each read.

## Next

- [Proof of an address and the claim rule](/docs/concepts/claim-rule/)
- [Sign up with a passkey](/docs/guides/passkey-sign-up/)
- [Anonymous sessions](/docs/guides/anonymous/)
