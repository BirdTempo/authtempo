---
title: authtempo users delete
description: Delete the account of a user on a request through the operator user tools. The organizations that the user alone holds go with it. It cannot be undone.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 6"
sidebar:
  order: 22
---

**For:** an operator who deletes an account on a request of the person, when the person cannot use the self delete.

**What it does:** this page lists the flags of `authtempo users delete`, its question, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` and `delete` scopes in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.
- The user id of the account. Read the user with [`authtempo users get`](/docs/reference/cli/users-get/) first: the delete cannot be undone.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users delete https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "request 4713"
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--reason <text>` | The audit row holds the reason of the act. It is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin, and then the command needs `--yes`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--yes` | Deletes with no question. A run with no terminal needs it. |
| `--no-input` | Never asks a question. Without `--yes`, the command then stops. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The deployment deleted the account. The command prints the audit row id and each organization that went with it. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no delete scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. A delete also stops at the limit of 100 deletes per actor per hour. |

Without `--yes`, the command asks one question and reads one line:

```text
Delete the account <user id>? This cannot be undone. Type the user id to confirm:
```

Only the typed user id deletes the account. A `yes`, an empty line, or any other text stops with `no delete: the answer was not the user id`, and no request goes out. A run with no terminal, with `--no-input`, or with `--token-file -` needs `--yes`. Else it stops with a usage error before any request.

On a success, stdout holds the line `deleted <user id>; audit row <id>`, then one line `deleted the organization <id>` for each organization that went with the account. The audit row id is the `id` of the row in `authtempo audit list`. The audit row holds the ids of those organizations, and no address.

The act ends a page of the user's sessions, and the sweep ends the rest. The user gets the mail `account_deleted` unless `account.notices` is false.

A refusal stops with exit 2, names its cause, and changes nothing:

- `sole_owner`: the user is the last owner of an organization with other members, or of the platform organization. Make another member an owner of each such organization first, then delete again.
- `delete_too_large`: the account holds too many organizations for one call. Delete the organizations that the user alone holds, or let the user leave the organizations that the user owns with another owner, first.
- A secret with no `delete` scope stops with `the operator secret has no delete scope`.
- No user has the id, a hook refused the act, or another change ran at the same time.

## The JSON

| Key | What it holds |
| --- | --- |
| `organizations` | The ids of the organizations that went with the account. |
| `auditId` | The id of the audit row of the act. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `organizations: []` and `auditId: ""`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/users/delete`](/docs/reference/routes/#post-operator-users-delete) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ userId, reason }`. |
| Answer | `{ organizations, auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. Each call also counts on `operator-delete:actor:<kind>:<id>`, 100 per hour for one secret, also a refused call. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`not_found`](/docs/reference/errors/#not_found), [`sole_owner`](/docs/reference/errors/#sole_owner), [`delete_too_large`](/docs/reference/errors/#delete_too_large), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo users get](/docs/reference/cli/users-get/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
