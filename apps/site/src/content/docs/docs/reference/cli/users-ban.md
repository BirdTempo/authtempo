---
title: authtempo users ban
description: Ban a user of a deployment through the operator user tools. The act ends a page of the user's sessions, and the sweep ends the rest.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
sidebar:
  order: 16
---

**For:** an operator who must stop a user from signing in.

**What it does:** this page lists the flags of `authtempo users ban`, its question, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users ban https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "spam" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--reason <text>` | The audit row holds the reason of the act. It is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. |
| `--until <date>` | The end of the ban: a date and time with a zone, from 1 minute to 3650 days after now. Without it, the ban has no end. |
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
| 0 | The deployment banned the user. The command prints the audit row id. |
| 1 | The act ran, but the end of the OAuth refresh families failed. The command prints the audit row id and a warning. Run authtempo sessions end for the user. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

The command asks one question that names the act and the user id: `Ban the user <user id>, and end the sessions of the user?` With `--yes` it asks nothing.
On a success, stdout holds one line: `banned <user id>; audit row <id>`. The audit row id is the `id` of the row in `authtempo audit list`.

An answer with `familyEndFailed: true` means that the ban committed, and the end of the OAuth refresh families after the commit failed. The command then prints the same line, and exits 1 with this line on stderr:

```text
warning: the act ran, but the end of the OAuth refresh families failed (familyEndFailed); run authtempo sessions end <base url> <user id> with a secret of the sessions scope
```

Run [`authtempo sessions end`](/docs/reference/cli/sessions-end/) for the user. It reads the refresh tokens of the user again, and ends each family.

A refusal stops with exit 2 and names its cause. For example, no user has the id, a hook refused the act, or another change ran at the same time.

A ban of a banned user is not refused. It writes the ban fields again: the time of the ban, the reason, and the end take the new values. So a second ban without `--until` makes a timed ban a ban with no end. The act also ends the user's access again, and writes a new audit row.

The act ends a page of the user's sessions, and the sweep ends the rest. Until then, each door refuses a left session. The act ends every challenge, handoff code, and OAuth refresh token and code of the user. An API token stays, and works again after an unban. A session JWT and an OAuth access token live to their `exp`.

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
| Route | [`POST /operator/users/ban`](/docs/reference/routes/#post-operator-users-ban) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ userId, reason, until }`. |
| Answer | `{ auditId }`, and `familyEndFailed: true` when the end of the OAuth families failed after the commit. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo users unban](/docs/reference/cli/users-unban/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
