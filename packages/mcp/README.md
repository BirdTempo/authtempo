# @authtempo/mcp

The authtempo MCP server. A coding agent uses it to search and read the authtempo docs, and to run the CLI in the project.

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

`src/tools.ts` holds the one tool table. The local binary serves every row. The remote Worker serves the rows with the remote surface only.

| Tool | Surface | What it does |
| --- | --- | --- |
| `docs.search` | local and remote | Searches the sections of the docs with BM25 and answers the best sections. |
| `docs.read` | local and remote | Answers the agent markdown of one page or one section. With no path, it answers the index of every page. |
| `version` | local and remote | Answers the versions of core, the CLI, and the server, and the facts of the docs index. The remote surface answers `cli: null`. |
| `scaffold` | local | Writes a new app into `dir` through `authtempo init --json`. It overwrites no file and runs no install. |
| `migrate.plan` | local | Plans an import through `authtempo import --dry-run` and writes nothing. With `against: "database"`, it answers a `plan_id` for `migrate.run`. |
| `migrate.run` | local | Writes the users of a held plan through `authtempo import --target postgres`. It needs the `plan_id` and `confirm: true`. |
| `schema.migrate` | local | Applies the Postgres migrations through `authtempo migrate --target postgres`. `dry_run: true` answers a `plan_id`, and that `plan_id` with `confirm: true` runs the plan. |
| `check` | local | Runs `authtempo check` on the origin `base_url`. It answers the id, status, code, and docs link of each check, and no text of the deployment. |

Each tool answers `structuredContent` and the same JSON in one text block. A tool fault is a result with `isError: true`, not a protocol error. Each local tool reads the exit code and the stop reason from the `exit` and `stopped` keys of the CLI's `--json` document.

The local tools keep these rules:

- Every path of an input resolves inside `--root`, with each symbolic link resolved. Else the tool refuses it before the CLI runs.
- The tools call the CLI's `main` in process through a confined `Io`. It runs no child process and asks no question.
- No input is a secret. The connection string comes from the variable that `--url-env` names.
- A plan is held for 10 minutes and used once. It is bound to the input, to the SHA-256 of each file, and to the database.
- The server holds at most 16 plans. `schema.migrate` runs the dry run again and refuses when the database changed.
- D1 migrations stay a shell command: `authtempo migrate --target d1`.

## The prompts

Each skill folder in `skills/` is one prompt, with the text of its `SKILL.md`. The prompt name is the skill name without `authtempo-`.

| Prompt | Argument |
| --- | --- |
| `integrate-workers-d1`, `integrate-workers-postgres`, `integrate-node`, `integrate-bun` | `dir`, optional: the folder of the new app. |
| `protect-mcp-server` | `dir`, optional. It is the prompt of the stack `mcp-server`. |
| `integrate-binding` | `binding`, required: one of the bindings that the docs index lists. |
| `migrate-supabase`, `migrate-clerk`, `migrate-auth0`, `migrate-firebase`, `migrate-authjs`, `migrate-cognito`, `migrate-better-auth` | None. |
| `check-deployment` | `base_url`, optional: the origin of the deployed API. |

An argument that the prompt does not name is the JSON-RPC error -32602. The tests hold the prompts to the stacks, the bindings, and the import providers, both ways.

## The resources

Each docs page is the resource `authtempo://docs/<path>`, from the template `authtempo://docs/{+path}`. The home page `/docs/` is `authtempo://docs/index`. The text is the agent markdown of the page, as `text/markdown`.

`resources/list` answers 100 entries a page, in the sidebar order, with a cursor for the next page. A missing page answers the JSON-RPC error -32602 with the URI in its data.

## The remote Worker

`src/worker.ts` is the remote surface, a second Worker with its own `wrangler.jsonc`. It serves the docs tools, the resources, and the prompts, with no authentication. It holds no user data and logs no request.

The Worker checks its own limits (`src/limits.ts`) before the SDK reads the body:

- A body above 64 KiB answers 413.
- A present `Origin` outside the allowed list answers 403, and so does another `Host`.
- More than 120 calls a minute from one IP, in one isolate, answer 429. A Workers rate limiting binding is a second limit, never the only one.

The test script runs `wrangler deploy --dry-run` only. No task publishes the Worker.

## Build and test

The server reads the agent index that the site build writes. Turbo runs the steps in this order: the build of this package, the build of the site, and the copy of the index.

```sh
pnpm turbo run index --filter=@authtempo/mcp
pnpm turbo run test --filter=@authtempo/mcp --force
```

`src/protocol.ts` is the one file that imports the MCP SDK. The files that the remote Worker uses import no Node module, and a test checks this.
