---
title: authtempo sessions end-all
description: End the sessions of every user through the operator user tools. The command calls again until no session is left or the run reaches --max-calls.
type: reference
sources:
  - packages/cli/src/commands/sessions.ts
  - packages/cli/src/help/sessions.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 22
---

**For:** an operator who must end every session after a breach (ASVS 5.0.0 7.4.5).

**What it does:** this page lists the flags of `authtempo sessions end-all`, its loop, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `sessions` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo sessions end-all https://api.example.com --reason "breach" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--reason <text>` | The reason of the act, 1 to 500 characters with no control, format, or separator character and no lone surrogate. The audit row holds it. |
| `--limit <n>` | The most sessions of one call, from 1 to 1000. The default is 500. A call can end fewer. |
| `--max-calls <n>` | The most calls of one run, from 1 to 10000. The default is 100. |
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
| 0 | No session is left. The command prints the sums. |
| 1 | The run reached --max-calls with sessions left. Run it again. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no sessions scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

The command asks one question: `End the sessions of every user?` With `--yes` it asks nothing.

Each call ends one page of sessions inside the budget of the deployment, and answers `more`. The command calls again while `more` is true, up to `--max-calls`. A call that stops early at the budget is normal. Each call prints one line on stderr: `call <i>: ended <n>, more <true|false>`. The sums go to stdout at the end: `calls <n>, ended <n>, more <true|false>`.

Each call writes its own audit row. A stop in the middle keeps the sums of the calls before it, with exit 2. The sums line then goes to stdout, or the sums go in the JSON document.

The end of all sessions leaves the OAuth refresh tokens and the API tokens of each user. Revoke them in their own steps.

## The JSON

| Key | What it holds |
| --- | --- |
| `ended` | The sessions that the run ended, summed over the calls. |
| `calls` | The calls of the run. |
| `more` | The `more` of the last call: true while a session is left. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a usage error holds `ended: 0`, `calls: 0`, and `more: false`.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/sessions/end-all`](/docs/reference/routes/#post-operator-sessions-end-all) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ reason, limit }`. |
| Answer | `{ ended, more, auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo sessions end](/docs/reference/cli/sessions-end/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
