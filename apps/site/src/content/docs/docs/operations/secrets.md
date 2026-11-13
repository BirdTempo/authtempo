---
title: Secrets
description: What the app secret of authtempo protects, and how to change it with no lockout.
type: how-to
sources:
  - packages/core/README.md "Secrets"
sidebar:
  order: 2
---

**For:** an operator who keeps the secrets of an API with authtempo, or who must change one.

**What it does:** this guide lists what the app secret protects, and gives the steps of a change that locks nobody out.

## Before you start

- Access to the secret store of the API. On Workers that is `pnpm --filter my-app exec wrangler secret put`. On Node and Bun it is the process environment. [Deploy](/docs/operations/deploy/) sets the first value.
- Core at schema version 9 on every instance. An instance at version 8 writes each value under version 1. [Upgrades](/docs/operations/upgrades/) gives the steps.
- A way to run code in the API's process, for the [in-process API](/docs/reference/api/#the-in-process-api). Or the operator routes on, for the commands of [the CLI](/docs/reference/cli/).
- For the operator routes: run `authtempo secret --operator --out operator-secret.txt`. It writes the operator secret to the file and prints its `secretHash`. Store the operator secret in your secret store, then delete `operator-secret.txt`. [authtempo secret](/docs/reference/cli/secret/) gives the flags. Set `operator: { secretHash }` in the config, and deploy before step 5. Give the command the secret in `AUTHTEMPO_OPERATOR_SECRET`. Without the routes, steps 5 and 9 stop with exit 2 and "the operator route is off". A Better Auth compat app has no `operator` option, so the CLI forms of steps 5 and 9 do not apply. It calls the in-process API of the line before as `auth.tempo.api.secrets`.

## What the secret protects

| What | How | After a change that follows this guide |
| --- | --- | --- |
| A second factor secret | Sealed with AES-256-GCM under a key from the secret | Opens under its version. It moves to the current version at its next right code, or by `rewrap`. |
| A private signing key | Sealed under a key from the secret | Opens under its version. It moves at its next signature, or by `rewrap`. |
| A backup code | HMAC-SHA256 under the secret | Matches under its version until it is used or the list is replaced. |
| A live email code | HMAC-SHA256 under the secret | Passes under its version for its life, at most 60 minutes. |
| A social app payload of `social.stateData` | Sealed with AES-256-GCM under a key from the secret, in a state row or a challenge row | Opens under its version for its life, at most 10 minutes. `rewrap` does not move it. |
| A session, an API token, a magic link, a reset link | SHA-256 with no key | No change. |

Each such row names its version in the column `secret_version`. A read opens a value only under that version. A row from before schema version 9 reads as version 1.

`secret` is version 1. `secrets` lists the versions, the current one first, as `{ version, value }` entries. The current version seals and keys each new value. Give `secret`, `secrets`, or both. With both, `secrets` must not give version 1 another value.

The provider secrets, such as `social.google.clientSecret` and `social.apple.privateKey`, are separate settings. [Key rotation](/docs/operations/key-rotation/) tells how to change them.

## Steps

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

1. Make a new secret of 32 random bytes with `authtempo secret --version 2 --out secret-v2.txt`. The command writes a new file that only its owner can read, and replaces no file.

   On a machine with no CLI, use `openssl rand -base64 32`.

2. Store the line of the file as a second secret, for example `AUTH_SECRET_V2`. Keep `AUTH_SECRET` as it is. Then delete the file.
3. Replace `secret` with `secrets`, and read the old value as version 1. Put version 1 first, then version 2. Deploy to every instance at 100 percent.

   On Workers the key reads `secrets: [{ version: 1, value: env.AUTH_SECRET }, { version: 2, value: env.AUTH_SECRET_V2 }]`. On Node and Bun, read `process.env` in the same way.

   Remove the key `secret`. While it stays, core adds it back as version 1, and step 10 cannot remove that version.

   Do not keep `secret` beside a `secrets` list that holds only version 2. Core adds `secret` after it as version 1, so version 2 is current in one deploy, and this step does not happen.

   A gradual deployment keeps an old version of the API live. That version cannot open a value of version 2, so wait until the new version serves all traffic.

   Every instance now knows version 2, and version 1 stays current. Nothing is written under version 2 yet. If you skip this step, an instance on the old config cannot open a value of version 2. Its users then fail the second factor, and its signing key retires at each signature.

4. Put version 2 first in `secrets`, then version 1. Deploy to every instance at 100 percent. Each new value is now written under version 2.
5. Run `authtempo secret rewrap <base url> --yes`. The command ends when no row of an old version remains, when a pass ends, or at `--max-calls`. It exits 1 when a row did not open or rows remain. [authtempo secret rewrap](/docs/reference/cli/secret-rewrap/) gives the flags.

   The operator routes allow 120 calls an hour from one IP address. Each call stays inside 50 queries, the limit of D1 Free. The route's limiter query counts in the 50, so a call moves at most 42 rows. A call may stop early with `more: true`, and the command calls again. A run makes at most 100 calls, so it moves about 4 200 rows. Run it again while it exits 1.

   In the API's process, the same pass is `auth.api.secrets.rewrap({ limit: 100 })`. The answer is a result: read `value` when `ok` is true. On Workers Paid or Postgres, pass `callBudget` up to 1000 to move more rows in one call.

6. In the API's process, pass the `next` of each answer as `after` to the next call. Stop when `next` is `null`. That is one pass. The command does this step itself.
7. Run a new pass from step 5, with no `after`, while the last answer has `more: true`. Wait 15 minutes first when `skipped` or `failed` was above 0. With the command, run it again while it exits 1.

   A second run in the same hour can reach the limit of 120 calls. It then stops with exit 2 and a line that names the limit. Wait one hour, then run it again.

   After 3 passes with the same `failed` count, stop and read the second warning below. Such a row fails on every pass.

8. Wait for the life of the live email codes: `emailOtp.ttlMinutes`, 10 minutes by default. Wait at least 10 minutes, also with a shorter code life. A social app payload lives 10 minutes, and `rewrap` does not move it.
9. Run `authtempo secret status <base url>`. Remove a version only when the command lists each of its counts as 0. [authtempo secret status](/docs/reference/cli/secret-status/) gives the flags.

   In the API's process, run `auth.api.secrets.status()`. Read the entry of version 1. When `emailCodes` is above 0, wait for `emailOtp.ttlMinutes` again, then repeat step 9. When `stateData` is above 0, wait 10 minutes, then repeat step 9.

10. Remove version 1 from `secrets` when `totpSecrets`, `signingKeys`, `emailCodes`, `stateData`, `backupCodes`, and `ssoClientSecrets` are 0. A count of `ssoClientSecrets` above 0 means a sealed client secret of an SSO connection. Without the version, its sign-in fails. A SCIM token has no count. Core stores its SHA-256, not a sealed value, so a new app secret keeps it working. Make sure that the config has no key `secret`. Deploy.

   On Node and Bun, restart each process: it reads the environment only at start.

   Then delete `AUTH_SECRET` from the secret store, on every runtime. On Workers that is `pnpm --filter my-app exec wrangler secret delete AUTH_SECRET`.

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
- `status` reads every row of five tables, one query per 1000 rows. It reads the live codes and the live social state rows the same way. Run it from a script, not from a request.
- `stateData` counts the live sealed app payloads of `social.stateData`: state rows, and challenge rows of a social sign-in. A removed version fails each such sign-in with `invalid_token`, and the person starts again. `rewrap` leaves these rows, because each lives at most 10 minutes.
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

:::caution
Warning: a rollback to a build of core before schema version 9 is safe only before step 4. That build cannot open a row sealed under version 2. Its TOTP users then fail the second factor, and its signing keys retire.
:::

## If it fails

- [`invalid_code`](/docs/reference/errors/#invalid_code) at the second factor: the instance does not know the version of the user's row. Do step 3 on every instance.
- [`invalid_code`](/docs/reference/errors/#invalid_code) for an email code: its version left the config before the code expired. Ask for a new code.
- [`invalid_body`](/docs/reference/errors/#invalid_body) from `rewrap`: the `limit` is outside 1 to 1000, or `after` is not a `next` that `rewrap` answered.
- `createAuth` throws a config error that names an estimate of bits: the current secret is weak. Make a new one with step 1.
- A log line names a secret version that is not configured: a row holds a version that the config lacks. Add the version back, or let that row fail.

## Next

- [Key rotation](/docs/operations/key-rotation/)
- [The threat model](/docs/concepts/threat-model/)
