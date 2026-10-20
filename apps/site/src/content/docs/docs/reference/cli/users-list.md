---
title: authtempo users list
description: List the users of a deployment by id through the operator user tools, one page or every page.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 13
---

**For:** an operator who reads the users of a deployment from a terminal or a script.

**What it does:** this page lists the flags of `authtempo users list`, its table, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users list https://api.example.com
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--after <id>` | Start after this id. The cursor of the page before gives it. |
| `--limit <n>` | The rows of one page, from 1 to 100. The default is 50. |
| `--all` | Read each page after the first until the last page. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command printed the users. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. |

The users go to stdout as a table: `ID`, `EMAIL`, `VERIFIED`, `BAN`, `OPERATOR`, `FACTORS`, `SESSIONS`, and `CREATED`. `BAN` is `-` for no ban, `no-end` for a ban with no end, or the end of the ban. The name is in the JSON only.

With no `--all`, the command reads one page. When more users follow, stderr names the cursor: `more users after <id>: give --after <id>, or give --all`. With `--all`, the command reads each page until `next` is null. Each page costs one of the 600 calls of an hour.

## The JSON

| Key | What it holds |
| --- | --- |
| `users` | The users of the run, each with `id`, `email`, `emailVerified`, `name`, `createdAt`, `ban`, `platformOperator`, `secondFactor`, `sessions`, and `identities`. |
| `next` | The cursor of the next page, or null after the last page. A run with `--all` ends with null. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `users: []` and `next: null`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/users`](/docs/reference/routes/#get-operator-users) |
| Header | `Authorization: Operator <secret>` |
| Query | `after` and `limit`. |
| Answer | `{ users, next }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Next

- [authtempo users search](/docs/reference/cli/users-search/)
- [authtempo users](/docs/reference/cli/users/)
- [Routes](/docs/reference/routes/#operator-user-tools)
