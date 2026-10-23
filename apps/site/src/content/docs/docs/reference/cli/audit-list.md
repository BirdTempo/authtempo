---
title: authtempo audit list
description: List the audit rows of the operator acts of a deployment by id, the oldest first, one page or every page.
type: reference
sources:
  - packages/cli/src/commands/audit.ts
  - packages/cli/src/help/audit.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 26
---

**For:** an operator or an auditor who checks who did which act, when, and why.

**What it does:** this page lists the flags of `authtempo audit list`, its table, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `audit` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo audit list https://api.example.com --user 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--user <id>` | List only the rows of the acts on this user. |
| `--after <id>` | Start after this id. The cursor of the page before gives it. |
| `--limit <n>` | The rows of one page, from 1 to 100. The default is 50. |
| `--all` | Read each page after the first until the last page. A page then holds 100 rows unless --limit gives another count. |
| `--max-calls <n>` | The most calls of one run with --all, from 1 to 10000. The default is 100. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command printed the rows. |
| 1 | The read reached --max-calls with more rows. The command printed the rows that it read. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no audit scope, or the limit of 600 calls an hour. |

The rows go to stdout as a table: `ID`, `CREATED`, `ACTOR`, `ACTION`, `TARGET`, and `REASON`. `ACTOR` is the kind and the id of the actor, such as `secret:support`. A row names a secret by its name, never by the secret.

With no `--all`, the command reads one page, and stderr names the cursor of the next page. With `--all`, it reads each page until `next` is null.

With `--all`, the command stops at `--max-calls` with a warning and exit 1: `warning: the read reached --max-calls <n> with more rows; give --after <id> to read on`. It also stops with exit 2 when `next` equals the `after` of its own call, because that read never ends. A stop after the first page prints the rows that the run read before it.

## The JSON

| Key | What it holds |
| --- | --- |
| `rows` | The audit rows, each with `id`, `createdAt`, `updatedAt`, `actorKind`, `actorId`, `action`, `targetUserId`, `reason`, `data`, `ip`, and `userAgent`. |
| `next` | The cursor of the next page, or null after the last page. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop at the first call holds `rows: []` and `next: null`. A stop after the first page holds the rows read before it, and `next` is the cursor to read on from.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/audit`](/docs/reference/routes/#get-operator-audit) |
| Header | `Authorization: Operator <secret>` |
| Query | `targetUserId`, `after`, and `limit`. |
| Answer | `{ rows, next }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Next

- [authtempo users](/docs/reference/cli/users/)
- [authtempo sessions](/docs/reference/cli/sessions/)
- [Routes](/docs/reference/routes/#operator-user-tools)
