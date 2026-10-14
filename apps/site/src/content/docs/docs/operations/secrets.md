---
title: Secrets
description: What the app secret of authtempo protects, what a change of it breaks, and how to change it with the least harm.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 5
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.10
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.11
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.12
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
sidebar:
  order: 2
---

**For:** an operator who keeps the secrets of an API with authtempo, or who must change one.

**What it does:** this guide lists what `secret` protects, and gives the steps of a change.

## Before you start

- Access to the secret store of the API. On Workers that is `wrangler secret put`. On Node and Bun it is the process environment.
- A way to run code in the API's process, for the in-process api.

## What the secret protects

| What | How | After a new secret |
| --- | --- | --- |
| A live email code | HMAC-SHA256 under `secret` | Fails. The person asks for a new code. |
| A second factor secret | Sealed with AES-256-GCM under a key from `secret` | Opens no more. The person cannot pass the second factor. |
| A backup code | HMAC-SHA256 under `secret` | Matches no more. |
| A private signing key | Sealed under a key from `secret` | Retires with one log line, and a new key signs. Tokens of the old key verify for 24 hours. |
| A session, an API token, a magic link, a reset link | SHA-256 with no key | No change. |

The provider secrets, such as `social.google.clientSecret` and `social.apple.privateKey`, are separate settings. [Key rotation](/docs/operations/key-rotation/) tells how to change them.

## Steps

1. List the users with the second factor on. Each one has a row in `ta_totp`.
2. Tell each of them that they must set up the second factor again after the change.
3. For each user of step 1, call `auth.api.totp.disable({ userId })` in the API's process. Do this before the change, because no sealed key opens after it.
4. On Workers, store the new value with `pnpm exec wrangler secret put AUTH_SECRET`. The Worker reads it as `env.AUTH_SECRET`.
5. On Node and Bun, set `AUTH_SECRET` in the process environment of the server.
6. Deploy, so every instance reads the new value.
7. Read the log for the line about a signing key that does not open. One line is expected.

The table prefix `ta_` keeps the old product name tempo-auth for compatibility. [Schema and migrations](/docs/reference/schema/) states the rule.

## How it behaves

- `secret` must hold 32 characters or more. `createAuth` refuses a shorter value at construction.
- Two instances with two secrets at the same time retire each other's signing keys at each mint. Deploy the change to every instance at once.
- A new `secret` changes no password hash. PBKDF2 needs no key.

:::caution
Warning: a new `secret` locks every user with the second factor out of it, and out of the backup codes. Do step 3 for each such user before the change, or each one stays locked out.
:::

## If it fails

- [`invalid_code`](/docs/reference/errors/#invalid_code) at the second factor after the change: step 3 did not run for that user.
- [`invalid_code`](/docs/reference/errors/#invalid_code) for an email code: the code is from before the change. Ask for a new one.
- A JWT check fails on another server after 24 hours: that server keeps an old key set. It must read `/auth/jwks` again.

## Next

- [Key rotation](/docs/operations/key-rotation/)
- [Turn on the second factor](/docs/guides/second-factor/)
- [The threat model](/docs/concepts/threat-model/)
