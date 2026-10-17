---
name: authtempo-integrate-binding
description: Add one authtempo framework package, such as the Next, Hono, or SvelteKit binding, to an app that runs authtempo, through the docs tools of the authtempo MCP server. Use it when a person wants the session of authtempo in a framework. In the steps, {binding} is the name of the binding.
metadata:
  source: /docs/start/
---

# Add an authtempo framework package

**For:** a coding agent that adds the authtempo package of one framework to an app of a person.

**What it does:** you find the reference page of the binding {binding}, and you do its steps in the code of the app.

## Before you start

- The authtempo MCP server runs in this project.
- An API that runs authtempo. A skill of a stack, such as `authtempo-integrate-node`, makes one.
- A clone of the authtempo repo. The packages are not on a registry yet, so the app lives in the pnpm workspace of the repo.

## Steps

1. Call `docs.search` with the query {binding} and the type `reference`.
2. Find the page of the package for {binding} in the hits. Its group is Frameworks.
3. Call `docs.read` with the path of that page. Read its steps and its exports.
4. Add the package of the page to the dependencies of the app. Run `pnpm install` at the root of the repo.
5. Do each step of the page in the code of the app, in order.
6. Run the tests of the app.
7. Ask the person to sign in once, and to open a route that reads the session.

## If it fails

- [`unauthorized`](/docs/reference/errors/#unauthorized): the request has no session. Sign the person in first.
- [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted): a page posts from an origin that is not `baseURL`. Add the origin to `trustedOrigins`.
- A protected path does not send the person to the sign-in page: read the section of the page on the path that `protect` gets.

## Next

- [Mount authtempo on any other stack](/docs/guides/other-stacks/)
- [Choose your stack](/docs/start/)
