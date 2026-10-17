---
name: authtempo-integrate-workers-d1
description: Write a new Cloudflare Worker on D1 with authtempo sign-in, through the tools of the authtempo MCP server. Use it when a person asks for authtempo in a new app on Workers and D1. In the steps, {dir} is the folder of the new app.
metadata:
  source: /docs/start/workers-d1/
---

# Add authtempo to a new Worker on D1

**For:** a coding agent that writes a new Cloudflare Worker with authtempo on a D1 database for a person.

**What it does:** the `scaffold` tool writes the app of the tutorial. You then run its next steps, and a person signs in with a magic link.

## Before you start

- The authtempo MCP server runs in this project. Its root is the folder of the project.
- Node 22.18 or newer, and pnpm 12.8.1.
- A clone of the authtempo repo. The packages are not on a registry yet, so the app lives in the pnpm workspace of the repo.
- A Cloudflare account, for the deploy at the end.

## Steps

1. Call `docs.read` with the path `/docs/start/workers-d1/`. Read the page before you write a file.
2. Call `scaffold` with the stack `workers-d1`. Its dir is {dir}. It writes new files and overwrites no file.
3. Show the person the `files` and the `next` list of the answer.
4. In the new folder, run each command of the `next` list in the shell, in order.
5. The list holds `authtempo migrate --target d1`. It applies the migrations to the local D1 database.
6. Do the deploy steps of the page with the person. Each deploy step needs the Cloudflare sign-in of the person.
7. Ask the person to sign in once with a mailed link.

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
