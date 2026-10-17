---
name: authtempo-protect-mcp-server
description: Let authtempo sign in the callers of an MCP server of the person, with access tokens for its resource, through the tools of the authtempo MCP server. Use it for a new MCP server on Workers with D1, or for an MCP server that exists. In the steps, {dir} is the folder of a new app.
metadata:
  source: /docs/guides/mcp-server/
---

# Protect an MCP server with authtempo

**For:** a coding agent that adds authtempo sign-in to the MCP server of a person.

**What it does:** core mints the access tokens. `requireMcpAuth` lets a request reach a tool only with a valid token for the MCP resource.

## Before you start

- The authtempo MCP server runs in this project. Its root is the folder of the project.
- Node 22.18 or newer, and pnpm 12.8.1.
- A clone of the authtempo repo. The packages are not on a registry yet, so the app lives in the pnpm workspace of the repo.
- A Cloudflare account and a domain on Cloudflare, for the deploy.

## Steps

1. Call `docs.read` with the path `/docs/guides/mcp-server/`. Read the whole page.
2. Ask the person if the MCP server exists. For a new server, do steps 3 and 4. Else do steps 5 to 7.
3. Call `scaffold` with the stack `mcp-server`. Its dir is {dir}. It writes the app of `examples/mcp-server`.
4. Do the steps of the tutorial [An MCP server on Workers with D1](/docs/start/mcp-server/) from its step 2. Then go to step 8.
5. Do step 1 of the guide: turn on `oauth` in the config of core, with each option of that step.
6. Do step 2 of the guide: answer each path under `/.well-known/` with the documents of core.
7. Do step 3 of the guide: wrap the handler of the MCP route in `requireMcpAuth` of `@authtempo/verify/mcp`.
8. Ask the person to connect an MCP client, to sign in, and to call a tool of the server.

## If it fails

- The answer of `scaffold` has `isError` and an `exists:` line: a file of the folder exists. Call `scaffold` with a new folder.
- [`invalid_token`](/docs/reference/errors/#oauth-invalid_token): the token is expired, of another resource, or not an OAuth access token.
- [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope): the token lacks the scope of the challenge. The client must ask for that scope.
- [`invalid_client`](/docs/reference/errors/#oauth-invalid_client): the client id is unknown. It must be the URL of a metadata document that the guarded fetch accepts.
- A source that fails gives 503 with no body. [The verify MCP entry](/docs/reference/verify-mcp/) lists both sources.

## Next

- [An MCP server on Workers with D1](/docs/start/mcp-server/)
- [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/)
