---
title: authtempo mcp
description: Add the authtempo MCP server to the project config of an editor, or print each entry to add by hand.
type: reference
sources:
  - packages/cli/src/editors.ts
  - packages/cli/src/commands/mcp.ts
  - docs/superpowers/plans/2026-10-14-11e-mcp.md "Task 2"
sidebar:
  order: 7
---

**For:** a developer who wants a coding agent to read the authtempo docs and run the CLI through MCP.

**What it does:** this page lists the flags of `authtempo mcp`, the file of each editor, and the rule for a file that exists.

## Before you start

- The server package, built in this repo with `pnpm --filter @authtempo/mcp build`. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The `--remote` entry needs no build.
- [The CLI](/docs/reference/cli/) lists the exit codes and the output.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.

```sh
authtempo mcp --claude-code
authtempo mcp ./app --cursor --url-env APP_DATABASE_URL
authtempo mcp --manual --remote
```

| Flag | What it does |
| --- | --- |
| `[dir]` | The project folder. The default is the current folder. |
| `--claude-code` | Writes `.mcp.json`. Claude Code asks for approval before it uses a project server from `.mcp.json`. |
| `--cursor` | Writes `.cursor/mcp.json`. |
| `--codex` | Writes `.codex/config.toml`. A Codex project file applies only in a trusted project. |
| `--opencode` | Writes `opencode.json`. When the project has `opencode.jsonc`, the command prints the entry and stops. |
| `--vscode` | Writes `.vscode/mcp.json`. The entry uses `${workspaceFolder}` and has no `env` line. |
| `--manual` | Writes no file. Prints the entry of each editor and the `claude mcp add` and `codex mcp add` commands. |
| `--remote` | Uses the remote server at `https://mcp.authtempo.com/mcp`. It serves the docs tools only and is not live before publication. |
| `--url-env <NAME>` | The variable that holds the connection string. The default is `DATABASE_URL`. The file holds the name, never the value. |
| `-n`, `--dry-run` | Prints the file and its new text, and writes nothing. |
| `--json` | Prints `{ editor, file, action, entry }`. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command wrote the entry, found the same entry, or printed it. |
| 2 | A usage error, a file that does not parse, another authtempo entry, or a server that is not built. The test hook AUTHTEMPO_MCP_BIN names another server file. |

## The targets

Each shape comes from the docs of the editor, read on 2026-10-14. The command writes in the project folder only, never in your home folder.

| Target | File | Key |
| --- | --- | --- |
| `--claude-code` | `.mcp.json` | `mcpServers` |
| `--cursor` | `.cursor/mcp.json` | `mcpServers` |
| `--codex` | `.codex/config.toml` | `[mcp_servers.authtempo]` |
| `--opencode` | `opencode.json` | `mcp` |
| `--vscode` | `.vscode/mcp.json` | `servers` |
| `--manual` | none | none |

The entry starts the local server with `--root` and the absolute path of the project folder. VS Code gets `${workspaceFolder}` in its place. No file holds the value of a variable. Each entry names the variable, and the editor reads it at its start.

## A file that exists

The command adds one server, `authtempo`, and keeps every other key in its place.

| Case | What the command does |
| --- | --- |
| No file | Writes the new file. |
| A file with no server map | Adds the map at the end of the file. |
| The same `authtempo` entry | Writes nothing, and says `already set`. Exit 0. |
| Another `authtempo` entry | Prints both entries, writes nothing, and stops. Exit 2. |
| No `authtempo` entry | Adds `authtempo` at the end of the server map. |
| A JSON file with comments | Prints the entry to add by hand, and stops. A rewrite drops the comments. Exit 2. |
| A file that does not parse | Writes nothing, and stops. Exit 2. |
| A Codex file with a `[mcp_servers.authtempo` line | Writes nothing, and stops. Exit 2. |
| A Codex file with no such line | Adds the table at the end. The old text stays as it is. |

## Next

- [The CLI](/docs/reference/cli/)
- [authtempo init](/docs/reference/cli/init/)
