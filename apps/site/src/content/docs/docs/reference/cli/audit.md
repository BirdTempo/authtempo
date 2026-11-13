---
title: authtempo audit
description: The subcommand of authtempo audit. It reads the audit rows of the operator acts of a deployment.
type: reference
sources:
  - packages/cli/src/commands/audit.ts
  - packages/cli/src/help/audit.ts
sidebar:
  order: 26
---

**For:** an operator or an auditor who checks the operator acts of a deployment.

**What it does:** this page lists the subcommands of `authtempo audit`. Each subcommand has its own page.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `audit` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

```sh
authtempo audit list https://api.example.com
```

| Subcommand | What it does | Page |
| --- | --- | --- |
| `authtempo audit list` | Lists the audit rows of the operator acts by id. | [authtempo audit list](/docs/reference/cli/audit-list/) |

`authtempo audit` with no subcommand is a usage error. With `--json` it prints `{ exit, stopped }`.

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
