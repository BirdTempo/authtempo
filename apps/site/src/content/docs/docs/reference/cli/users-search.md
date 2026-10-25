---
title: authtempo users search
description: Find users by an exact address, an exact id, or the start of an address through the operator user tools.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 14
---

**For:** an operator who must find the user of a support request.

**What it does:** this page lists the flags of `authtempo users search`, its table, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users search https://api.example.com --email ada@example.com
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--email <address>` | Find the user of this exact address. |
| `--email-prefix <prefix>` | Find the users whose address starts with this text, from 3 to 254 characters. The deployment reads every user for it. |
| `--id <id>` | Find the user of this exact id. |
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
| 0 | The command printed the users that match. No match prints the header only. |
| 1 | The read reached --max-calls with more rows. The command printed the rows that it read. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. |

Give exactly one of `--email`, `--email-prefix`, and `--id`. Two or none is a usage error.

The users go to stdout as a table: `ID`, `EMAIL`, `VERIFIED`, `BAN`, `OPERATOR`, `FACTORS`, `SESSIONS`, and `CREATED`. `EMAIL` is `-` for a user with no address, such as a phone sign-up. `BAN` is `-` for no ban, `no-end` for a ban with no end, or the end of the ban. The name is in the JSON only.

The address goes in the query of the request and in the answer on stdout only. No stderr line names it, also on a stop. No match prints the header only.

A prefix search reads every user of the deployment. It matches with case and with no wildcard: `%` and `_` match only themselves.

With `--all`, the command reads each page until `next` is null. It stops at `--max-calls` with a warning and exit 1: `warning: the read reached --max-calls <n> with more users; give --after <id> to read on`. It also stops with exit 2 when `next` equals the `after` of its own call, because that read never ends. A stop after the first page prints the users that the run read before it.

## The JSON

| Key | What it holds |
| --- | --- |
| `users` | The users of the run, each with `id`, `email`, `emailVerified`, `name`, `createdAt`, `ban`, `platformOperator`, `secondFactor`, `sessions`, and `identities`. |
| `next` | The cursor of the next page, or null after the last page. A run with `--all` ends with null, unless it stops. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop at the first call holds `users: []` and `next: null`. A stop after the first page holds the users read before it, and `next` is the cursor to read on from.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/users/search`](/docs/reference/routes/#get-operator-users-search) |
| Header | `Authorization: Operator <secret>` |
| Query | One of `email`, `emailPrefix`, and `id`, then `after` and `limit`. |
| Answer | `{ users, next }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Next

- [authtempo users get](/docs/reference/cli/users-get/)
- [authtempo users](/docs/reference/cli/users/)
- [Routes](/docs/reference/routes/#operator-user-tools)
