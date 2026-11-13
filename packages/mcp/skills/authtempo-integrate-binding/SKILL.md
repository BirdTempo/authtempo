---
name: authtempo-integrate-binding
description: Add one authtempo framework package, such as the Next, Hono, or SvelteKit binding, to an app that runs authtempo, through the docs tools of the authtempo MCP server. Use it when a person wants the session of authtempo in a framework. In the steps, {binding} is the name of the binding, and {binding_page} is the path of its reference page.
metadata:
  source: /docs/start/
---

# Add an authtempo framework package

**For:** a coding agent that adds the authtempo package of one framework to an app of a person.

**What it does:** you read the reference page of the binding {binding}, and you do its steps in the code of the app.

## Before you start

- The authtempo MCP server runs in this project.
- An API that runs authtempo. A skill of a stack, such as `authtempo-integrate-node`, makes one.
- The `@authtempo` packages are on npm, so the app installs them with `pnpm install`.

## Steps

1. Call `docs.read` with the path {binding_page}. It is the reference page of {binding} in the docs index.
2. Read the steps and the exports of the page.
3. Add the package of the page to the dependencies of the app. Run `pnpm install` at the root of the repo.
4. Do each step of the page in the code of the app, in order.
5. Run the tests of the app.
6. Ask the person to sign in once, and to open a route that reads the session.

## If it fails

- [`unauthorized`](/docs/reference/errors/#unauthorized): the request has no session. Sign the person in first.
- [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted): a page posts from an origin that is not `baseURL`. Add the origin to `trustedOrigins`.
- A protected path does not send the person to the sign-in page: read the section of the page on the path that `protect` gets.

## Next

- [Mount authtempo on any other stack](/docs/guides/other-stacks/)
- [Choose your stack](/docs/start/)
