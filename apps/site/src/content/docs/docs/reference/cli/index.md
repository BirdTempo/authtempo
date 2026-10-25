---
title: The CLI
description: The authtempo command line, its commands, its exit codes, its output, and its rule for secrets.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 19
  - packages/cli/README.md "The rules"
  - packages/cli/README.md "Install"
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 9"
  - docs/superpowers/plans/2026-10-14-11c2-cli-additions.md "Task 8"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 12"
  - packages/cli/src/stacks.ts
sidebar:
  order: 1
---

**For:** a developer or an operator who sets up, migrates, checks, or maintains an API with authtempo.

**What it does:** this page lists each command of `authtempo`, and the rules that every command keeps.

## Before you start

- Node 22 or newer.
- A clone of the authtempo repo. The `@authtempo` packages are not on a registry yet, so the command runs only from the repo. [Choose your stack](/docs/start/) tells why.

## Run it from this repo

The root of the repo has no `authtempo` binary, and an app that `authtempo init` writes does not depend on `@authtempo/cli`. Build the CLI once in the repo. Then run each command with `node` and the absolute path of the repo, in the folder of your app.

```sh
cd /path/to/authtempo
pnpm turbo run build --filter=@authtempo/cli
cd /path/to/my-app
node /path/to/authtempo/packages/cli/dist/bin/authtempo.js --help
```

- Write the path of your clone in place of `/path/to/authtempo`.
- The command reads and writes each relative path, such as `--config` or `--users`, from the current folder.
- A test runs this form from a temporary folder, and checks the folder and the exit codes.

`pnpm --filter authtempo-example-worker exec authtempo` runs in `examples/worker`, not in your folder, and exits 1 on any failure. Use it for `--help` only.

## The commands

| Command | What it does | Page |
| --- | --- | --- |
| `authtempo init` | Writes a new app with a magic link sign-in on one stack. | [authtempo init](/docs/reference/cli/init/) |
| `authtempo migrate` | Applies the migrations of the adapter, after the version gate. | [authtempo migrate](/docs/reference/cli/migrate/) |
| `authtempo import` | Moves the users of another provider into authtempo. | [authtempo import](/docs/reference/cli/import/) |
| `authtempo check` | Checks that a deployment answers as core promises. | [authtempo check](/docs/reference/cli/check/) |
| `authtempo keys rotate` | Makes a new signing key through the operator route. | [authtempo keys rotate](/docs/reference/cli/keys/) |
| `authtempo mcp` | Adds the authtempo MCP server to the config of an editor in this project. | [authtempo mcp](/docs/reference/cli/mcp/) |
| `authtempo-import` | The old import binary. It stays for one release. | [authtempo import](/docs/reference/cli/import/) |
| `authtempo secret` | Makes an app secret or an operator secret from 32 random bytes. | [authtempo secret](/docs/reference/cli/secret/) |
| `authtempo secret status`, `authtempo secret rewrap` | Counts and reseals the rows of each app secret version through the operator routes. | [authtempo secret status](/docs/reference/cli/secret-status/), [authtempo secret rewrap](/docs/reference/cli/secret-rewrap/) |
| `authtempo info` | Prints a support report with no secret value. | [authtempo info](/docs/reference/cli/info/) |
| `authtempo users` | Reads, creates, bans, unbans, updates, and deletes users, changes the platform role, and turns a second factor off, through the operator user tools. | [authtempo users](/docs/reference/cli/users/) |
| `authtempo sessions` | Ends the sessions of one user or of all users through the operator user tools. | [authtempo sessions](/docs/reference/cli/sessions/) |
| `authtempo audit list` | Lists the audit rows of the operator acts. | [authtempo audit list](/docs/reference/cli/audit-list/) |
| `authtempo create-admin` | Makes the first platform operator of a deployment. | [authtempo create-admin](/docs/reference/cli/create-admin/) |
| `authtempo generate` | Prints the schema of the authtempo tables as SQL, Drizzle, or Prisma. | [authtempo generate](/docs/reference/cli/generate/) |

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
| 1 | A person must look: a check failed, a record or a row needs a person, or a part of the report gave no answer. |
| 2 | A usage error, a malformed input, or a stop. A stop prints one stopped line. |

A stop prints its `stopped:` line on stderr.

## The output

- stdout holds the result.
- stderr holds the usage errors, the warnings, the `stopped:` line, and each progress line that names what the command reads or connects to.
- A result line on stdout can name a file or the base URL, such as `wrote <path>` of `init`.
- `--json` prints one JSON document on stdout, and nothing else there. A script reads that document, not the human lines.
- On a usage error or a stop, `--json` prints one document with `exit: 2` and the reason in `stopped`. Each other key holds its empty value, such as `""`, `[]`, or `null`.
- Each document of `--json` holds `exit`, the exit code of the run, and `stopped`, which is null when the run did not stop. `--version --json` has neither key.
- The human lines can change in a later version. A JSON document only gains keys, and a removal comes after a deprecation.
- The CLI writes no color and no terminal control.

## Secrets

- No flag takes a secret as its value.
- A connection string comes from `--url-env <NAME>` or `--url-file <path>`. The default variable is `DATABASE_URL`.
- The operator secret comes from `--token-env <NAME>` or `--token-file <path>`. The default variable is `AUTHTEMPO_OPERATOR_SECRET`.
- A libSQL token comes from `--auth-token-env <NAME>` or `--auth-token-file <path>`. The default variable is `LIBSQL_AUTH_TOKEN`. The token is optional.
- A file of `-` is stdin.
- No output line holds a secret that the command read. The CLI names a database by its host, its port, and its name only.
- `authtempo secret` prints the secret that it makes once, or writes it to a new file that only its owner can read. It replaces no file.

:::caution
Warning: a value on the command line goes into the shell history and the process list. Do not give a secret as a flag value.
:::

## The help

- `authtempo --help`, `authtempo help <command>`, and `authtempo <command> --help` print the complete help, with the link to the page of the command.
- A flag one edit from a known flag gets "Did you mean", and the command does not run.
- With no command, `authtempo` prints the short help on stderr and exits 2.

## The stacks entry

`@authtempo/cli/stacks` holds the stacks of `authtempo init`, for a tool that lists them. It imports nothing.

| Export | What it is |
| --- | --- |
| `STACKS` | The stack names of `authtempo init --stack`, in order. |
| `Stack` | One member of `STACKS`. |
| `STACK_INFO` | The facts of each stack: its example, its label, its tutorial page, its secrets file, and its steps. |
| `StackInfo` | One row of `STACK_INFO`. |

## Next

- [authtempo init](/docs/reference/cli/init/)
- [authtempo check](/docs/reference/cli/check/)
- [Deploy](/docs/operations/deploy/)
