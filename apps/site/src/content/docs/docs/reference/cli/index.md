---
title: The CLI
description: The authtempo command line, its commands, its exit codes, its output, and its rule for secrets.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 19
  - packages/cli/README.md "The rules"
  - packages/cli/README.md "Install"
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 9"
sidebar:
  order: 1
---

**For:** a developer or an operator who sets up, migrates, checks, or maintains an API with authtempo.

**What it does:** this page lists each command of `authtempo`, and the rules that every command keeps.

## Before you start

- Node 22.18 or newer.
- A clone of the authtempo repo. The `@authtempo` packages are not on a registry yet, so the command runs only from the repo. [Choose your stack](/docs/start/) tells why.

## Run it from this repo

The root of the repo has no `authtempo` binary. The example Worker depends on `@authtempo/cli`, so pnpm links the binary there. Build the CLI first, and then run a command through the example Worker, or with `node`.

```sh
pnpm turbo run build --filter=@authtempo/cli
pnpm --filter authtempo-example-worker exec authtempo --help
node packages/cli/dist/bin/authtempo.js --help
```

An app that `authtempo init` writes does not depend on `@authtempo/cli`. Run each command for that app from the repo, in one of these two forms.

## The commands

| Command | What it does | Page |
| --- | --- | --- |
| `authtempo init` | Writes a new app with a magic link sign-in on one stack. | [authtempo init](/docs/reference/cli/init/) |
| `authtempo migrate` | Applies the migrations of the adapter, after the version gate. | [authtempo migrate](/docs/reference/cli/migrate/) |
| `authtempo import` | Moves the users of another provider into authtempo. | [authtempo import](/docs/reference/cli/import/) |
| `authtempo check` | Checks that a deployment answers as core promises. | [authtempo check](/docs/reference/cli/check/) |
| `authtempo keys rotate` | Makes a new signing key through the operator route. | [authtempo keys rotate](/docs/reference/cli/keys/) |
| `authtempo-import` | The old import binary. It stays for one release. | [authtempo import](/docs/reference/cli/import/) |

## The flags

| Flag | What it does |
| --- | --- |
| `--version` | Prints the version of the CLI and the schema version of its core. |
| `--json` | Prints one JSON document on stdout. The human lines go to stderr. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

## The exit codes

| Exit code | What it means |
| --- | --- |
| 0 | Done. Every check passed, or the command made the change that it named. |
| 1 | A person must look: a check failed, or an import record needs a person. |
| 2 | A usage error, a malformed input, or a stop. A stop prints one stopped line. |

A stop prints its `stopped:` line on stderr.

## The output

- stdout holds the result.
- stderr holds the usage errors, the warnings, the `stopped:` line, and each line that names a host, a database, or a file.
- `--json` prints one JSON document on stdout, and nothing else there. A script reads that document, not the human lines.
- The human lines can change in a later version. A JSON document only gains keys, and a removal comes after a deprecation.
- The CLI writes no color and no terminal control.

## Secrets

- No flag takes a secret as its value.
- A connection string comes from `--url-env <NAME>` or `--url-file <path>`. The default variable is `DATABASE_URL`.
- The operator secret comes from `--token-env <NAME>` or `--token-file <path>`. The default variable is `AUTHTEMPO_OPERATOR_SECRET`.
- A file of `-` is stdin.
- No output line holds a secret that the command read. The CLI names a database by its host, its port, and its name only.

:::caution
Warning: a value on the command line goes into the shell history and the process list. Do not give a secret as a flag value.
:::

## The help

- `authtempo --help`, `authtempo help <command>`, and `authtempo <command> --help` print the complete help, with the link to the page of the command.
- A flag one edit from a known flag gets "Did you mean", and the command does not run.
- With no command, `authtempo` prints the short help on stderr and exits 2.

## Next

- [authtempo init](/docs/reference/cli/init/)
- [authtempo check](/docs/reference/cli/check/)
- [Deploy](/docs/operations/deploy/)
