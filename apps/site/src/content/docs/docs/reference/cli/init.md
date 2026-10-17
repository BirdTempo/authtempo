---
title: authtempo init
description: Write a new app with a magic link sign-in on Workers with D1, Workers with Postgres, Node, Bun, or an MCP server on Workers with D1.
type: reference
sources:
  - packages/cli/README.md "init"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 19
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 7"
  - docs/superpowers/plans/2026-10-14-11e-mcp.md "Task 13"
sidebar:
  order: 2
---

**For:** a developer who starts a new app with authtempo.

**What it does:** this page lists the stacks of `authtempo init`, the files that it writes, and the next steps that it prints.

## Before you start

- Read [The CLI](/docs/reference/cli/) for the exit codes and the output.
- [Choose your stack](/docs/start/) compares the stacks.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo init my-app --stack workers-d1
```

| Flag | What it does |
| --- | --- |
| `[dir]` | The folder of the app. The default is the current folder. |
| `--stack <stack>` | `workers-d1`, `workers-postgres`, `node`, `bun`, or `mcp-server`. It has no default. |
| `--json` | Prints `{ stack, dir, files, next }`. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command wrote every file, and printed the next steps. |
| 2 | A usage error, or the folder holds a file of the app. The command then writes nothing. |

## The stacks

| Stack | The example that it copies | The tutorial |
| --- | --- | --- |
| `workers-d1` | `examples/worker-d1` | [Workers on D1](/docs/start/workers-d1/) |
| `workers-postgres` | `examples/worker-postgres` | [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/) |
| `node` | `examples/node` | [Node](/docs/start/node/) |
| `bun` | `examples/node`, with `bun src/main.ts` as its start script | [Bun](/docs/start/bun/) |
| `mcp-server` | `examples/mcp-server`, an MCP server on a Worker with D1 | [An MCP server on Workers with D1](/docs/start/mcp-server/) |

The `node` stack and the `bun` stack need Node 22.18 or newer. Node runs their `.ts` files with its type stripping.

## The files

- Each file of the example app of the stack. The tutorial of the stack shows them.
- `tsconfig.base.json`, a copy of the base config of the repo. Each `tsconfig*.json` of the app extends it.
- `README.md`, with the next steps and the links.
- `.gitignore`, which lists `node_modules`, `.wrangler/`, `.dev.vars`, `.env`, and `dist`.
- `.dev.vars.example` on Workers, or `.env.example` on Node and Bun. It lists each secret with no value.

## The rules

- The files are those of the example apps, with five changes only.
- The name of the app is `my-app`, and each `@authtempo` package has its exact version.
- Each `tsconfig*.json` extends the copied base config. The test script of `workers-d1` and `mcp-server` has no bundle proof of the repo.
- The start script of the Bun stack is `bun src/main.ts`.
- `init` runs no install and needs no network. It prints `pnpm install` as a next step.
- `init` writes no secret. A test scans each file for a key, a token, and a password.
- A folder that holds any file of the stack stops the run with exit 2. `init` then lists each such file, and writes nothing.
- The Node and Bun servers apply the migrations at their start. On Workers, the next steps name `authtempo migrate`.
- Until the packages are on a registry, a new app installs only inside the pnpm workspace of the repo.

## Next

- [authtempo migrate](/docs/reference/cli/migrate/)
- [Workers on D1](/docs/start/workers-d1/)
- [Deploy](/docs/operations/deploy/)
