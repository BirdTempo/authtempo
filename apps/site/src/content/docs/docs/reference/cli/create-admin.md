---
title: authtempo create-admin
description: Make the first platform operator of a deployment through the operator user tools. The operator has no power before a sign-in and a second factor.
type: reference
sources:
  - packages/cli/src/commands/create-admin.ts
  - packages/cli/src/help/create-admin.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 25
---

**For:** an operator who sets up the first platform operator of a new deployment.

**What it does:** this page lists the flags of `authtempo create-admin`, its output, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.
- `organizations.platformOrganization` and `organizations.platformRole` in the config. [Configuration](/docs/reference/config/) lists the keys.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo create-admin https://api.example.com --email root@example.com --reason "first operator" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--email <address>` | The address of the operator. The command prints no address on stderr. |
| `--name <name>` | The name of a new user, from 1 to 200 characters. |
| `--reason <text>` | The reason of the act, from 1 to 500 characters with no control character. The audit row holds it. |
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
| 0 | The deployment made the operator. The command prints the user id. The user has no power before a sign-in and a second factor. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. |

The command asks one question: `Make the user of the given address a platform operator?` With `--yes` it asks nothing. No stderr line names the address.

In one transaction, the route makes the platform organization when it is absent, with the new operator as `owner` and the platform role. It makes the user when no user holds the address, with no password and an address that is not verified. It then adds the member row.

On a success, stdout holds the user id. stderr then prints:

```text
Next: sign in with a mailed link or code at this address, then turn a second factor on. Until then the account has no operator power.
```

The operator user guard needs a verified address, a second factor, and a fresh session. So the new operator has no power before the first sign-in by a mailed link or code, and a second factor.

## The JSON

| Key | What it holds |
| --- | --- |
| `userId` | The id of the operator. |
| `created` | True when the run made a new user. |
| `auditId` | The id of the audit row of the act. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `userId: ""`, `created: false`, and `auditId: ""`.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/users/create-admin`](/docs/reference/routes/#post-operator-users-create-admin) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ email, name, reason }`. |
| Answer | `{ userId, created, auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`account_banned`](/docs/reference/errors/#account_banned), [`member_limit`](/docs/reference/errors/#member_limit), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo users platform-role](/docs/reference/cli/users-platform-role/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
