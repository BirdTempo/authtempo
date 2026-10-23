---
title: authtempo users update
description: Correct the name or the image of a user through the operator user tools. The command sends no address and no password.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 6"
sidebar:
  order: 20
---

**For:** an operator who corrects the name or the image of a user on a support request.

**What it does:** this page lists the flags of `authtempo users update`, its question, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users update https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --name "Ada Lovelace" --reason "ticket 4711" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--name <name>` | The new name: 1 to 200 UTF-16 code units with no control or format character. |
| `--no-name` | Removes the name. The user then has no name. |
| `--image <url>` | The new image: an https URL with a host, of at most 2048 characters, with no space. |
| `--no-image` | Removes the image. The user then has no image. |
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
| 0 | The deployment changed the user. The command prints the audit row id. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

Give at least one of `--name`, `--no-name`, `--image`, and `--no-image`, and at most one flag for each field. Else the command stops with a usage error and sends no request.

The command asks one question that names the fields and the user id, such as `Change the name and the image of the user <user id>?` With `--yes` it asks nothing.
On a success, stdout holds one line, such as `changed the name of <user id>; audit row <id>`. The audit row id is the `id` of the row in `authtempo audit list`.

The audit row names the changed fields, never a value. The act sends no mail: a name and an image are not credentials. No flag changes the address, the password, the role, or the ban.

A refusal stops with exit 2 and names its cause. For example, no user has the id, a hook refused the act, or another change ran at the same time. A value that the deployment refuses stops with `invalid_body` and the rule of the two flags.

## The JSON

| Key | What it holds |
| --- | --- |
| `user` | The user after the change, with the keys of `authtempo users get --json`. |
| `auditId` | The id of the audit row of the act. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `user: null` and `auditId: ""`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/users/update`](/docs/reference/routes/#post-operator-users-update) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ userId, name, image, reason }`. `--no-name` and `--no-image` send null. A field with no flag is not in the body. |
| Answer | `{ user, auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`not_found`](/docs/reference/errors/#not_found), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo users get](/docs/reference/cli/users-get/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
