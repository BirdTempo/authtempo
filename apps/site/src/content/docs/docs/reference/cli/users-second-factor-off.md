---
title: authtempo users second-factor-off
description: Turn every second factor of a user off after a check of the identity of the person, through the operator user tools.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
sidebar:
  order: 19
---

**For:** an operator who helps a user who lost a second factor (ASVS 5.0.0 6.4.4).

**What it does:** this page lists the flags of `authtempo users second-factor-off`, its question, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.
- A check of the identity of the person at the level of the enrollment, with a case id in your own system. [Second factor recovery](/docs/operations/second-factor-recovery/) gives the steps.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users second-factor-off https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "lost phone" --proof-method document --proof-reference case-4711 --proof-checked-at 2026-10-20T09:30:00Z --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--reason <text>` | The audit row holds the reason of the act. It is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. |
| `--proof-method <method>` | How the identity was checked: document, in_person, video, knowledge, or other. |
| `--proof-reference <text>` | The case id of the check in your own system, from 1 to 200 characters. Never the evidence itself. |
| `--proof-checked-at <date>` | The time of the check: a date and time with a zone, at most 7 days old. The deployment refuses a time after its own clock. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin, and then the command needs `--yes`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--yes` | Does the act with no question. A run with no terminal needs it. |
| `--no-input` | Never asks a question. Without `--yes`, the command then stops. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The deployment turned the factors off. The command prints the audit row id. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

The command asks one question that names the act and the user id: `Turn every second factor of the user <user id> off?` With `--yes` it asks nothing.
On a success, stdout holds one line: `turned the second factor of <user id> off; audit row <id>`. The audit row id is the `id` of the row in `authtempo audit list`.

A refusal stops with exit 2 and names its cause. For example, the user is banned, a hook refused the act, or another change ran at the same time.

The deployment reads `--proof-checked-at` against its own clock. A time after that clock gets `invalid_body`, also when the clock of your machine runs ahead. The command then names the flag. Give the time of the check as your system recorded it.

The user gets the mail `factor_disabled` unless `account.notices` is false. The audit row holds the method, the reference, and the time of the check, never the evidence.

## The JSON

| Key | What it holds |
| --- | --- |
| `auditId` | The id of the audit row of the act. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `auditId: ""`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/users/second-factor/disable`](/docs/reference/routes/#post-operator-users-second-factor-disable) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ userId, reason, proof: { method, reference, checkedAt } }`. |
| Answer | `{ auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [Second factor recovery](/docs/operations/second-factor-recovery/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
