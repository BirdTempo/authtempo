---
title: authtempo users create
description: Create a user for a person through the operator user tools, with an address or a phone number only. The command sets no password.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 6"
sidebar:
  order: 20
---

**For:** an operator who creates an account for a person, such as in an app whose self sign-up is closed.

**What it does:** this page lists the flags of `authtempo users create`, its question, its output, its JSON document, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.
- For a user with a phone number only, the `phone` config of the deployment. For `--first-sign-in reset`, the `password` config. [Configuration](/docs/reference/config/) lists both.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo users create https://api.example.com --email ada@example.com --name "Ada Lovelace" --reason "ticket 4710" --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--email <address>` | The address of the new user. |
| `--phone <E.164>` | The phone number of a new user with no address: a plus sign and 8 to 15 digits. The deployment needs the phone config. |
| `--name <name>` | The name: 1 to 200 UTF-16 code units with no control or format character. |
| `--image <url>` | The image: an https URL with a host, of at most 2048 characters, with no space. |
| `--verified` | Marks the address as verified. Give it only when you checked the address yourself. The deployment then takes the address as proved, and no later proof resets the account. So a wrong address gives the account to the owner of that address. |
| `--first-sign-in invite`, `--first-sign-in reset`, `--first-sign-in none` | How the person signs in first. `invite` mails an invitation link and is the default. `reset` mails a reset link. `none` mails nothing. |
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
| 0 | The deployment created the user. The command prints the user id on stdout, and the audit row id and the next step on stderr. |
| 1 | The deployment created the user, but no link went out: the mail failed, or the domain of the address enforces SSO. The command prints the user id and a warning. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no users scope, or the limit of 600 calls an hour. A refusal of the act stops too, with its cause. A create also stops at the limit of 200 creates per actor per hour. |

Give exactly one of `--email` and `--phone`. `--verified` and `--first-sign-in invite` or `reset` need `--email`. Else the command stops with a usage error and sends no request.

The deployment refuses an address with a phone number (`invalid_body`), and the command refuses `--email` with `--phone` before any request. A phone number that an operator chose, beside a proved address, would let the operator sign in to the account by a phone code. That sign-in would have no impersonation mark, no time limit, and no audit row. The person can add a phone number later, from a session.

The command asks one question, such as `Create a user, and mail the invitation link to the address?` The question names no address and no phone number. With `--yes` it asks nothing.

On a success, stdout holds the user id only, so a script can read it. Stderr holds `created the user <user id>; audit row <id>`, then the next step of the person:

| First sign-in | The next step on stderr |
| --- | --- |
| `invite` | `Next: the person signs in with the mailed link.` |
| `reset` | `Next: the person sets a password with the mailed reset link.` |
| `none` | `Next: the person signs in by any proof of the address.` |
| A phone number | `Next: the person signs in with a phone code.` No SMS goes out at the create. |

No line of the output holds the address, the phone number, a token, or a link. The deployment mails the link to the person only.

When no link goes out, the deployment keeps the user. The command then prints a `warning:` line on stderr and exits 1. There are two causes. The mail failed: the log of the deployment holds the event `operator.create_mail_failed`. Or the domain of the address enforces SSO: the person signs in by SSO.

A refusal stops with exit 2 and names its cause. An address that an account holds stops with `an account holds this address; find it with users search`. A phone number that an account holds stops too. A value that the deployment refuses stops with `invalid_body` and the rules of the flags.

## The JSON

| Key | What it holds |
| --- | --- |
| `userId` | The id of the new user. |
| `mailed` | `invite`, `reset`, or null: what the deployment mailed to the person. Never a token or a link. |
| `auditId` | The id of the audit row of the act. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop holds `userId: ""`, `mailed: null`, and `auditId: ""`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ email, phone, emailVerified, name, image, firstSignIn, reason }`. `--phone` sends `email: null`. `--verified` sends `emailVerified: true`. A field with no flag is not in the body. |
| Answer | `{ userId, mailed, auditId }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. Also the key `operator-create:actor:<kind>:<id>`, 200 calls an hour for one actor, also a refused call. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`phone_invalid`](/docs/reference/errors/#phone_invalid), [`phone_region`](/docs/reference/errors/#phone_region), [`email_taken`](/docs/reference/errors/#email_taken), [`phone_taken`](/docs/reference/errors/#phone_taken), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Next

- [authtempo users get](/docs/reference/cli/users-get/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
