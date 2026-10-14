---
title: Observability
description: Read the log lines that authtempo writes, and know which fault each line names.
type: how-to
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.9
  - packages/core/README.md "Hooks"
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
sidebar:
  order: 6
---

**For:** an operator who watches an API with authtempo in production.

**What it does:** this guide lists every log line of the packages, and what to do for each.

## Before you start

- Access to the logs of the API. On Workers, `pnpm exec wrangler tail` streams them.

## Steps

1. Stream the log during a deploy and a cutover.
2. Alert on each line of the table that says "act".
3. Count the lines of the table that say "watch", and alert when the count rises.

## The lines

Each line starts with `authtempo:` or `authtempo compat:`. It holds an event name, a provider name, a row id, an HTTP status, or an error name. It never holds a token, a code, a cookie, an address, or an error message.

| Line | Cause | What to do |
| --- | --- | --- |
| `authtempo: unhandled error <method> <path> <error name>` | A route threw, and answered 500. | Act. Read the route and the error name. |
| `authtempo: before hook failed <hook> <error name>` | A before hook threw, and the flow answered `hook_failed`. | Act. Fix the hook. |
| `authtempo: after hook failed <hook> <row id> <error name>` | An after hook threw after the commit. The flow answered success. | Act. The app's own row for that id is missing. |
| `authtempo: hook event copy failed <hook> <error name>` | The event of a hook could not be copied. | Act. |
| `authtempo: session patch refused <what>` | `session.beforeCreate` answered a key or a type that core refuses. | Act. Fix the hook. |
| `authtempo: oidc discovery request failed`, `answered`, `is not JSON`, `issuer mismatch`, `lacks an endpoint` | The discovery document of an `oidc` provider could not be used. | Act. Check the issuer, or set `endpoints`. |
| `authtempo: social client secret failed`, `social token request failed`, `social token endpoint answered`, `social token answer has no token` | The code exchange with a provider failed. | Act when it repeats. Check the client secret. |
| `authtempo: social id token rejected`, `social nonce mismatch` | The ID token of a provider did not verify. | Watch. |
| `authtempo: social user info failed`, `social user info has a bad subject` | The user info step of a provider failed. | Watch. |
| `authtempo: passkey registration rejected`, `passkey authentication rejected` | A WebAuthn ceremony did not verify. | Watch. |
| `authtempo: passkey credential already registered`, `passkey counter moved` | A known credential, or a counter race. | Watch. |
| `authtempo: email code count gave up <row id>`, `second-factor challenge count gave up <row id>` | The guess count lost its race too often. | Watch. |
| `authtempo: backup code spend gave up`, `backup code replacement gave up` | A backup code write lost its race too often. | Watch. |
| `authtempo: a signing key does not open under this secret; it retires <kid>` | `secret` changed. A new key signs. | Act when no change was planned. |
| `authtempo: jwtMint.claims threw`, `jwtMint.claims answered a value that is not an object` | The claims function of the app failed. | Act. |
| `authtempo: client metadata document refused <why>` | An OAuth client's metadata document was refused. | Watch. |
| `authtempo: the delete of a refresh row in a revoked grant failed <row id>` | A cleanup failed. The sweep deletes the row. | Watch. |
| `authtempo: cognito legacy verify failed <reason>` | Cognito refused an imported user, or did not answer. | Act when it is every user. |
| `authtempo compat: <note>` | An option of the compatibility package changes no promise. | Read once at start. |
| `authtempo compat: a credential account row has no password; …` | A Better Auth row has no hash. | Act. Give the row a hash, or delete it. |
| `authtempo compat: organizationHooks.<name> returned data that changes <fields>; …` | An organization hook of the app returned changed data. The write stops. | Act. Fix the hook. |
| `authtempo compat: databaseHooks.session.create.before changed <fields>; …` | The session hook of the app changed a field that core drops. | Act. Fix the hook. |

## How it behaves

- Core writes each line with `console.error`, and each note of the compatibility package with `console.info`.
- An after hook failure never fails the request. The log line is the only sign.
- The sweep writes no line. Read its counts from `sweepExpired()`.

## If it fails

- No line in a day of traffic: the log of the host is off, or the stream reads another Worker.
- Many `unhandled error` lines with a storage error: a migration is missing. [Upgrades](/docs/operations/upgrades/) tells how to apply it.
- [`hook_failed`](/docs/reference/errors/#hook_failed) answers: read the `before hook failed` line of the same time.

## Next

- [Run your code at a flow point](/docs/guides/hooks/)
- [The threat model](/docs/concepts/threat-model/)
- [Deploy](/docs/operations/deploy/)
