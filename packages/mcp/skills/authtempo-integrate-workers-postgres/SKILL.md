---
name: authtempo-integrate-workers-postgres
description: Write a new Cloudflare Worker on Postgres through Hyperdrive with authtempo sign-in, through the tools of the authtempo MCP server. Use it when a person asks for authtempo in a new app on Workers and Postgres. In the steps, {dir} is the folder of the new app.
metadata:
  source: /docs/start/workers-hyperdrive/
---

# Add authtempo to a new Worker on Postgres

**For:** a coding agent that writes a new Cloudflare Worker with authtempo on Postgres through Hyperdrive for a person.

**What it does:** the `scaffold` tool writes the app of the tutorial. You then run its next steps, and a person signs in with a magic link.

## Before you start

- The authtempo MCP server runs in this project. Its root is the folder of the project.
- Node 22.18 or newer, pnpm 12.8.1, and Docker.
- The `@authtempo` packages are on npm, so the app installs them with `pnpm install`.
- A Postgres database and a Cloudflare account, for the deploy at the end.

## Steps

1. Call `docs.read` with the path `/docs/start/workers-hyperdrive/`. Read the page before you write a file.
2. Call `scaffold` with the stack `workers-postgres`. Its dir is {dir}. It writes new files and overwrites no file.
3. Show the person the `files` and the `next` list of the answer.
4. In the new folder, run each command of the `next` list in the shell, in order.
5. The list sets `DATABASE_URL` in the shell. Ask the person for the value, and write it in no file.
6. The list holds `authtempo migrate --target postgres`. It applies the migrations to the database of `DATABASE_URL`.
7. Do the deploy steps of the page with the person. Each deploy step needs the Cloudflare sign-in of the person.
8. Ask the person to sign in once with a mailed link.

## If it fails

- The answer has `isError` and an `exists:` line: a file of the folder exists. Call `scaffold` with a new folder.
- The answer has `isError` and the text "outside the server root": give a relative path inside the root.
- A command of the list exits 2 and prints a `stopped:` line. [The exit codes](/docs/reference/cli/#the-exit-codes) give each code.
- `authtempo migrate` stops before a write. [The version gate](/docs/reference/cli/migrate/#the-version-gate) tells why.
- [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted): a page posts from an origin that is not `baseURL`. Add the origin to `trustedOrigins`.
- [`rate_limited`](/docs/reference/errors/#rate_limited): a limit of the flow is full. Wait for the window to end.

## Next

- [Your first sign-in from a web app](/docs/start/first-sign-in/)
- After the deploy, use the skill `authtempo-check-deployment`.
