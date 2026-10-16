---
title: Fresh sessions
description: Why a sensitive change needs a recent sign-in or a re-authentication, and which changes need one.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.15
  - packages/core/README.md "Account"
  - docs/superpowers/plans/2026-10-14-12a-account-self-service.md
---

**For:** a developer who decides which changes of an account need a new proof.

**What it does:** this page explains the fresh rule, the re-authentication, and the changes that core guards.

## Before you start

- Read [Sessions, API tokens, and JWTs](/docs/concepts/credentials/) for what a session is.

## The rule

A session is fresh while its sign-in or its last re-authentication is younger than `session.freshMinutes`. The default is 1440 minutes, one day, as in Better Auth. A thief who copies a session token gets a stale session after that time. The thief then cannot lock the owner out.

A re-authentication proves the person again with the password, an email code, or a passkey. With the second factor on, the password and the email code need the factor code too. A passkey proves two factors, so it needs no factor code. The re-authentication keeps the session token and the expiry. It does not extend the absolute lifetime of a session.

## What needs a fresh session

| Change | Why |
| --- | --- |
| The change of address, a link, an unlink | Each changes a way to sign in or to recover the account |
| A passkey register and delete, a first password | Each adds or removes a way in |
| A password change while the second factor is on | The current password alone is one factor |
| The second factor on and off, and new backup codes | ASVS 5.0.0 7.5.1 asks for a full re-authentication |
| An API token create | A token is a credential for its life |
| The revoke of one session or of the others | ASVS 5.0.0 7.5.2 |
| The account delete | It cannot be undone |

The session list, the identity list, and the profile update need a session only. A password change with no second factor needs no fresh session, because the current password is the proof. `POST /totp/setup` turns nothing on, so it has no rule. The enable after it applies the rule.

## The answer

A stale session gets 403 `session_not_fresh`, and nothing changes. The rule answers before any limit counts a try. The client re-authenticates and sends the change again. `client.withFresh` does both, and it never loops.

## The server calls

The in-process calls that take a user apply no fresh rule. They are `api.passkeyRegistrationOptions`, `api.deletePasskey`, `api.tokens.create`, `api.totp.disableWithCode`, and `api.totp.regenerateBackupCodesWithCode`. The app's server code calls `api.session.requireFresh(resolved)` first. `api.totp.enable` and `api.password.change` take a session, and they apply the rule themselves.

## Next

- [Build an account settings page](/docs/guides/account-settings/)
- [Routes: Account](/docs/reference/routes/#account)
