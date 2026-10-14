---
title: Secrets
description: What the app secret of authtempo protects, and how to change it with no lockout.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 5
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.10
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.11
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.12
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 22
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
  - docs/superpowers/plans/2026-10-14-12b-security-hardening.md "Task 13"
  - packages/core/README.md "Secrets"
sidebar:
  order: 2
---

**For:** an operator who keeps the secrets of an API with authtempo, or who must change one.

**What it does:** this guide lists what the app secret protects, and gives the steps of a change that locks nobody out.

## Before you start

- Access to the secret store of the API. On Workers that is `pnpm --filter my-app exec wrangler secret put`. On Node and Bun it is the process environment. [Deploy](/docs/operations/deploy/) sets the first value.
- Core at schema version 9 on every instance. An instance at version 8 writes each value under version 1. [Upgrades](/docs/operations/upgrades/) gives the steps.
- A way to run code in the API's process, for the [in-process API](/docs/reference/api/#the-in-process-api).

## What the secret protects

| What | How | After a change that follows this guide |
| --- | --- | --- |
| A second factor secret | Sealed with AES-256-GCM under a key from the secret | Opens under its version. It moves to the current version at its next right code, or by `rewrap`. |
| A private signing key | Sealed under a key from the secret | Opens under its version. It moves at its next signature, or by `rewrap`. |
| A backup code | HMAC-SHA256 under the secret | Matches under its version until it is used or the list is replaced. |
| A live email code | HMAC-SHA256 under the secret | Passes under its version for its life, at most 60 minutes. |
| A session, an API token, a magic link, a reset link | SHA-256 with no key | No change. |

Each such row names its version in the column `secret_version`. A read opens a value only under that version. A row from before schema version 9 reads as version 1.

`secret` is version 1. `secrets` lists the versions, the current one first, as `{ version, value }` entries. The current version seals and keys each new value. Give `secret`, `secrets`, or both. With both, `secrets` must not give version 1 another value.

The provider secrets, such as `social.google.clientSecret` and `social.apple.privateKey`, are separate settings. [Key rotation](/docs/operations/key-rotation/) tells how to change them.

## Steps

1. Make a new secret of 32 random bytes with `openssl rand -base64 32`.
2. Store it as a second secret, for example `AUTH_SECRET_V2`. Keep `AUTH_SECRET` as it is.
3. Set `secrets` to version 1 with the old value first, then version 2 with the new value. Deploy to every instance.

   Every instance now knows version 2, and version 1 stays current. Nothing is written under version 2 yet. If you skip this step, an instance on the old config cannot open a value of version 2. Its users then fail the second factor, and its signing key retires at each signature.

4. Set `secrets` to version 2 first, then version 1. Deploy to every instance. Each new value is now written under version 2.
5. In the API's process, run `auth.api.secrets.rewrap({ limit: 100 })`. The answer is a result: read `value` when `ok` is true.
6. Pass the `next` of each answer as `after` to the next call. Stop when `next` is `null`. That is one pass.
7. When an answer of the pass has `skipped` or `failed` above 0, wait 15 minutes. Then run a new pass from step 5, with no `after`.

   Stop when the last answer of a pass has `more: false`. A row that fails on every pass keeps `more` true: read the second warning below.
8. Wait for the life of the live email codes: `emailOtp.ttlMinutes`, 10 minutes by default.
9. Run `auth.api.secrets.status()`. Read the entry of version 1.
10. Remove version 1 from `secrets` when `totpSecrets`, `signingKeys`, `emailCodes`, and `backupCodes` are 0. Deploy. Then delete `AUTH_SECRET` from the secret store.

   When `backupCodes` stays above 0, read the first warning below before you remove the version.

`packages/core/README.md`, section "Secrets", holds the rewrap loop as code. The table prefix `ta_` and the names in the seal keep the old product name tempo-auth for compatibility. [Schema and migrations](/docs/reference/schema/) states the rule.

## How it behaves

- `createAuth` refuses any secret shorter than 32 characters. It also refuses a current secret with an estimate under 100 bits.
- The estimate is the length times log2 of the distinct characters. An estimate under 120 bits writes one warning line, also for an old version.
- The estimate does not see a pattern: `0123456789abcdef` twice gives 128 bits. Use random bytes.
- One pass of `rewrap` reads each row of a configured old version once, in the order of the ids. A row that fails stays behind the cursor, so it never stops a later row.
- `more` is true while a row of a configured old version remains, also a row that failed or was skipped. A `limit` outside 1 to 1000, or a cursor that `rewrap` did not answer, answers `invalid_body`.
- `skipped` counts a TOTP setup that is not confirmed, holds backup codes, and is less than 15 minutes old. A later pass reseals the expired setup and clears its codes.
- `failed` counts a row that did not open under its version, or that a concurrent write changed first. The log names the table, the row, and the version. A later pass reads it again.
- `status` reads every row of four tables, one query per 1000 rows. Run it from a script, not from a request.
- A backup code cannot move to a new version: core never sees the code again. `status` counts the unused codes under each version.
- `rewrap` never reads a row of a version that the config does not hold. `status` lists that version with `configured: false`.
- A signing key of a removed version does not open. It retires at the next signature, and a new key signs.
- A new secret changes no password hash. PBKDF2 needs no key.

:::caution
Warning: a removed version takes its unused backup codes with it. Read `status` first. When `backupCodes` is above 0 for the old version, ask each such user to make new codes before you remove it.
:::

:::caution
Warning: a TOTP user whose row stays under a removed version cannot pass the second factor. Remove a version only when its `totpSecrets` is 0. A row that fails on every pass needs a new setup by its user.
:::

## If it fails

- [`invalid_code`](/docs/reference/errors/#invalid_code) at the second factor: the instance does not know the version of the user's row. Do step 3 on every instance.
- [`invalid_code`](/docs/reference/errors/#invalid_code) for an email code: its version left the config before the code expired. Ask for a new code.
- [`invalid_body`](/docs/reference/errors/#invalid_body) from `rewrap`: the `limit` is outside 1 to 1000, or `after` is not a `next` that `rewrap` answered.
- `createAuth` throws a config error that names an estimate of bits: the current secret is weak. Make a new one with `openssl rand -base64 32`.
- A log line names a secret version that is not configured: a row holds a version that the config lacks. Add the version back, or let that row fail.

## Next

- [Key rotation](/docs/operations/key-rotation/)
- [The threat model](/docs/concepts/threat-model/)
