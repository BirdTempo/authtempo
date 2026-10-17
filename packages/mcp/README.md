# @authtempo/mcp

The authtempo MCP server. A coding agent uses it to search and read the authtempo docs. Later tasks of plan 11e add the tools that run the CLI.

The package is private. It is not published.

## The binary

`dist/bin/authtempo-mcp.js` serves MCP on stdio. Install it in an editor with `authtempo mcp`, or run it by hand:

```sh
node packages/mcp/dist/bin/authtempo-mcp.js --root /path/to/project
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--root <dir>` | the current folder | The project folder. The server resolves it once, at start. A file is a usage error. |
| `--url-env <NAME>` | `DATABASE_URL` | The name of the variable that holds the connection string. The value never goes in a tool input. |
| `--index <file>` | `dist/agent/index.json` | The agent index to read. |

The server writes only MCP messages to stdout. It writes each log line to stderr. A usage error exits 2. A stdin line that is not JSON gets the JSON-RPC error -32700 and one log line.

## The tools

| Tool | What it does |
| --- | --- |
| `docs.search` | Searches the sections of the docs with BM25 and answers the best sections. |
| `docs.read` | Answers the agent markdown of one page or one section. With no path, it answers the index of every page. |
| `version` | Answers the versions of core, the CLI, and the server, and the facts of the docs index. |

Each tool answers `structuredContent` and the same JSON in one text block. A tool fault is a result with `isError: true`, not a protocol error.

## Build and test

The server reads the agent index that the site build writes. Turbo runs the steps in this order: the build of this package, the build of the site, and the copy of the index.

```sh
pnpm turbo run index --filter=@authtempo/mcp
pnpm turbo run test --filter=@authtempo/mcp --force
```

`src/protocol.ts` is the one file that imports the MCP SDK. The files that the remote Worker uses import no Node module, and a test checks this.
