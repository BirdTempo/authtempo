---
title: authtempo users
description: The subcommands of authtempo users. They read, create, ban, update, and delete users, change the platform role, and turn a second factor off.
type: reference
sources:
  - packages/cli/src/commands/users.ts
  - packages/cli/src/help/users.ts
sidebar:
  order: 12
---

**For:** an operator who supports the users of a deployment from a terminal or a script.

**What it does:** this page lists the subcommands of `authtempo users`. Each subcommand has its own page.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `users` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

```sh
authtempo users list https://api.example.com
```

| Subcommand | What it does | Page |
| --- | --- | --- |
| `authtempo users list` | Lists the users by id, one page or every page. | [authtempo users list](/docs/reference/cli/users-list/) |
| `authtempo users search` | Finds users by an exact address, an exact id, or the start of an address. | [authtempo users search](/docs/reference/cli/users-search/) |
| `authtempo users get` | Reads one user by id. | [authtempo users get](/docs/reference/cli/users-get/) |
| `authtempo users ban` | Bans a user. The act ends a page of the user's sessions, and the sweep ends the rest. | [authtempo users ban](/docs/reference/cli/users-ban/) |
| `authtempo users unban` | Lifts the ban of a user. | [authtempo users unban](/docs/reference/cli/users-unban/) |
| `authtempo users platform-role` | Grants or revokes the platform role. On a revoke, the act ends a page of the user's sessions, and the sweep ends the rest. | [authtempo users platform-role](/docs/reference/cli/users-platform-role/) |
| `authtempo users second-factor-off` | Turns the second factor of a user off after a check of the identity. | [authtempo users second-factor-off](/docs/reference/cli/users-second-factor-off/) |
| `authtempo users create` | Creates a user for a person, with an address or a phone number only. It sets no password. | [authtempo users create](/docs/reference/cli/users-create/) |
| `authtempo users update` | Corrects the name or the image of a user. | [authtempo users update](/docs/reference/cli/users-update/) |
| `authtempo users delete` | Deletes the account of a user on a request. It needs the `delete` scope, and it cannot be undone. | [authtempo users delete](/docs/reference/cli/users-delete/) |

`authtempo users` with no subcommand is a usage error. With `--json` it prints `{ exit, stopped }`.

| Flag | What it does |
| --- | --- |
| `--json` | Prints `{ exit, stopped }` on a usage error. `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command printed its help. |
| 2 | A usage error: the command needs a subcommand. |

## Next

- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
