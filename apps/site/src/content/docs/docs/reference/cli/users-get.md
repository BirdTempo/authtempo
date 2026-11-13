---
title: authtempo users get
description: Read one user of a deployment by id through the operator user tools.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
sidebar:
  order: 15
---

**For:** an operator who checks the state of one user before an act.

**What it does:** this page lists the flags of `authtempo users get`, its output, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

```sh
authtempo users get https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `<user id>` | The id of the user. `authtempo users search` finds it by an address. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command printed the user. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. No user has the id stops too. |

The user goes to stdout as a table of one row, with the columns of `authtempo users list`.

A 404 has two causes: no user has the id, or the user tools are off. The command reads the user list once to tell which, and names the cause.

## The JSON

| Key | What it holds |
| --- | --- |
| `user` | The user, with the keys of `authtempo users list`. Null in the document of a stop. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/users/get`](/docs/reference/routes/#get-operator-users-get) |
| Header | `Authorization: Operator <secret>` |
| Query | `userId`. |
| Answer | `{ user }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Next

- [authtempo users ban](/docs/reference/cli/users-ban/)
- [authtempo users](/docs/reference/cli/users/)
- [Routes](/docs/reference/routes/#operator-user-tools)
