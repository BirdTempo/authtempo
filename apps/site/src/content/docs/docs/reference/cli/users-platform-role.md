---
title: authtempo users platform-role
description: Grant or revoke the platform role of a user. On a revoke, the act ends a page of the user's sessions, and the sweep ends the rest.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 18
---

**For:** an operator who adds or removes a platform operator.

**What it does:** this page lists the flags of `authtempo users platform-role`, its question, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users platform-role https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --grant --reason "support lead" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--grant` | Grant the role. The user needs a verified address and no active ban. |
| `--revoke` | Revoke the role. The act ends a page of the user's sessions, and the sweep ends the rest. |
| `--reason <text>` | The audit row holds the reason of the act. It is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. |
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
| 0 | The deployment changed the role. The command prints the audit row id. |
| 1 | A revoke ran. The act ran, but the end of the OAuth refresh families failed. The command prints the audit row id and a warning. Run authtempo sessions end for the user. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

Give exactly one of `--grant` and `--revoke`.

The command asks one question that names the act and the user id: `Grant the platform role to the user <user id>?`, or for a revoke, `Revoke the platform role of the user <user id>, and end the sessions of the user?` With `--yes` it asks nothing.
On a success, stdout holds one line: `granted the platform role to <user id>; audit row <id>`. The audit row id is the `id` of the row in `authtempo audit list`.

A revoke that answers `familyEndFailed: true` prints its line, and exits 1 with the warning of [`authtempo users ban`](/docs/reference/cli/users-ban/). Run [`authtempo sessions end`](/docs/reference/cli/sessions-end/) for the user then.

A refusal stops with exit 2 and names its cause. For example, the user is banned, a hook refused the act, or another change ran at the same time.

A grant needs a verified address and no active ban. A new platform operator has no power before a second factor and a fresh session.

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
| Route | [`POST /operator/users/platform-role`](/docs/reference/routes/#post-operator-users-platform-role) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ userId, grant, reason }`. |
| Answer | `{ auditId }`. A revoke adds `familyEndFailed: true` when the end of the OAuth families failed after the commit. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`email_unverified`](/docs/reference/errors/#email_unverified), [`account_banned`](/docs/reference/errors/#account_banned), [`member_limit`](/docs/reference/errors/#member_limit), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo create-admin](/docs/reference/cli/create-admin/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
