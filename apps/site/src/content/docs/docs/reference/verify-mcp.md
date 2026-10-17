---
title: The verify MCP entry
description: The rules, the two sources, and every export of @authtempo/verify/mcp, the guard of an app's own MCP server.
type: reference
sources:
  - packages/verify/README.md "Protect an MCP server"
  - packages/verify/src/mcp.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 20
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 21
  - docs/superpowers/plans/2026-10-14-11e-mcp.md
---

**For:** a developer of an app with its own MCP server that must accept only a valid access token.

**What it does:** this page lists the rules of `requireMcpAuth`, its two sources, and every export of the entry. The export check holds this page to `packages/verify/src/mcp.ts`.

## Before you start

- Read [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/) for the provider that mints the access tokens.

## The wrapper

`requireMcpAuth(source, handler, options)` answers a function of a `Request` to a `Response`. The handler gets the request and a `McpCaller`. A wrong option throws at construction.

| Option | Default | What it does |
| --- | --- | --- |
| `resource` | required | The resource of this MCP server: an entry of `oauth.resources`. |
| `scopes` | none | The scopes that every request needs. |
| `challengeScopes` | `scopes` | The scopes that the 401 names, so a client asks for them. |

The name follows Better Auth 1.7.7. Its older name `withMcpAuth` is not an export.

## The rules

| The request | The answer |
| --- | --- |
| A `resource` that is not `https:`. Construction accepts `http:` only on `127.0.0.1` or `localhost`. | Construction throws. |
| A `resource` with a query, a fragment, or user info | Construction throws. |
| A scope with a quote or a space, `offline_access`, or an empty list | Construction throws. |
| No bearer | 401 with the challenge of `resource` and `challengeScopes`. A session cookie is no credential here. |
| A bearer that is not an OAuth access token | The same 401 with `error="invalid_token"`. |
| A token for another resource of the same issuer | The 401 with `error="invalid_token"`. |
| A caller without every entry of `scopes` | 403 with `error="insufficient_scope"`. The challenge names every scope of the route. |
| A source that fails | 503 with no body, never 401. |
| A `McpScopeError` of the handler | 403 for the scopes of the error. Any other throw passes through. |
| A caller that passes | The answer of the handler, unchanged. |

The 401 and the 403 come from `unauthorizedResponse` and `insufficientScopeResponse` of the [verify package](/docs/reference/verify/). The challenge then has one source.

## The two sources

- A `Verifier` of `createVerifier`, for a server that is not the auth app. The wrapper uses it when the source has `verifyRequest`. A failure of `network` or `unexpected` gives 503.
- The `auth` of core, for an MCP route in the same Worker or process as the auth app. The wrapper calls `auth.caller` and maps `user.id` to `userId`. A throw of `caller` gives 503.

The second source fetches no key set. So a Worker does not fetch its own JWKS on its own host.

DPoP and token introspection come with row 12e, through the `Verifier`, with no new call.

## Exports

| Export | What it is |
| --- | --- |
| `requireMcpAuth` | Wraps the handler of an MCP route. |
| `McpScopeError` | The error that a handler throws when an operation needs more scopes. Its `scopes` field holds every scope of the operation. |

| Area | Types |
| --- | --- |
| The caller | `McpCaller` |
| The source | `McpSource` |

## Next

- [The verify package](/docs/reference/verify/)
