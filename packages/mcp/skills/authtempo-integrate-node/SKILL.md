---
name: authtempo-integrate-node
description: Write a new Node server on Postgres with authtempo sign-in, through the tools of the authtempo MCP server. Use it when a person asks for authtempo in a new Node app. In the steps, {dir} is the folder of the new app.
metadata:
  source: /docs/start/node/
---

# Add authtempo to a new Node server

**For:** a coding agent that writes a new Node HTTP server with authtempo on Postgres for a person.

**What it does:** the `scaffold` tool writes the app of the tutorial. You then run its next steps, and a person can sign in with a magic link.

## Before you start

- The authtempo MCP server runs in this project. Its root is the folder of the project.
- Node 22.18 or newer, pnpm 12.8.1, and Docker for the local Postgres.
- The `@authtempo` packages are on npm, so the app installs them with `pnpm install`.

## Steps

1. Call `docs.read` with the path `/docs/start/node/`. Read the page before you write a file.
2. Call `scaffold` with the stack `node`. Its dir is {dir}. It writes new files and overwrites no file.
3. Show the person the `files` and the `next` list of the answer.
4. Start the local Postgres with the step of the page.
5. In the new folder, run each command of the `next` list in the shell, in order.
6. The server applies the migrations at its start. Do not run them a second time.
7. Ask the person to sign in once with a mailed link.

## If it fails

- The answer has `isError` and an `exists:` line: a file of the folder exists. Call `scaffold` with a new folder.
- The answer has `isError` and the text "outside the server root": give a relative path inside the root.
- A command of the list exits 2 and prints a `stopped:` line. [The exit codes](/docs/reference/cli/#the-exit-codes) give each code.
- [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted): a page posts from an origin that is not `baseURL`. Add the origin to `trustedOrigins`.
- [`rate_limited`](/docs/reference/errors/#rate_limited): a limit of the flow is full. Wait for the window to end.

## Next

- [Your first sign-in from a web app](/docs/start/first-sign-in/)
- After the deploy, use the skill `authtempo-check-deployment`.
