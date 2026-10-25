---
title: authtempo sessions
description: The subcommands of authtempo sessions. They end the sessions of one user or of all users through the operator user tools.
type: reference
sources:
  - packages/cli/src/commands/sessions.ts
  - packages/cli/src/help/sessions.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
sidebar:
  order: 23
---

**For:** an operator who must end sessions after a theft of a device or a breach.

**What it does:** this page lists the subcommands of `authtempo sessions`. Each subcommand has its own page.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `sessions` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo sessions end https://api.example.com 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --reason "stolen laptop" --yes
```

| Subcommand | What it does | Page |
| --- | --- | --- |
| `authtempo sessions end` | Ends every session of one user. | [authtempo sessions end](/docs/reference/cli/sessions-end/) |
| `authtempo sessions end-all` | Ends the sessions of every user. | [authtempo sessions end-all](/docs/reference/cli/sessions-end-all/) |

`authtempo sessions` with no subcommand is a usage error. With `--json` it prints `{ exit, stopped }`.

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
