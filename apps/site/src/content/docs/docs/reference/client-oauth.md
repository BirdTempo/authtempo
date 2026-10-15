---
title: The OAuth client entry
description: The options, the calls, the answers, and every export of @authtempo/client/oauth.
type: reference
sources:
  - packages/client/README.md "The OAuth client"
  - packages/client/src/oauth/index.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 20
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
---

**For:** a developer of a third-party app that signs a person in to an authtempo OAuth provider.

**What it does:** this page lists the options and the calls of `createOAuthClient`, the answers, and every export of the entry. The export check holds this page to `packages/client/src/oauth/index.ts`.

## Before you start

- Read [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/) for the provider side.

## Options

`createOAuthClient(options)` answers an `OAuthClient`. The type of the options is `OAuthClientOptions`. A wrong option throws at construction.

| Option | Default | What it does |
| --- | --- | --- |
| `issuer` | required | `baseURL` plus `basePath` of the provider. An http or https URL with no query, fragment, or user info. |
| `clientId` | required | A `cl_` id of `registerOAuthClient`, or the URL of the client's metadata document. |
| `redirectUri` | required | A redirect URI of the client, exactly. |
| `resource` | required | The resource of the access token: an entry of `oauth.resources`. |
| `scopes` | required | One or more scopes. `offline_access` asks for a refresh token. |
| `fetch` | `globalThis.fetch` | The fetch of every call. |
| `crypto` | `webCrypto()` | The PKCE seam, a `PkceCrypto`. Hermes needs `expoCrypto` of `@authtempo/handoff/expo`. |
| `pending` | `memoryPendingStore()` | Where a sign-in waits for its redirect, a `PendingStore`. A single-page app passes `browserPendingStore()`. |
| `clock` | the system clock | Tests inject one. |

**Warning: the client accepts an `http:` issuer on any host.** It then sends the code, the verifier, and the tokens over plain HTTP. Use `https:` outside local development.

## Calls

| Call | Route | Value |
| --- | --- | --- |
| `authorizeURL()` | `GET /oauth/authorize` (built, not fetched) | The URL to open, with PKCE S256, `state`, `scope`, and `resource` |
| `handleRedirect(url)` | `POST /oauth/token` | `OAuthTokens`: `accessToken`, `tokenType`, `expiresAt`, `scopes`, `refreshToken`, `idToken` |
| `refresh(refreshToken, { scopes })` | `POST /oauth/token` | `OAuthTokens`. The `scopes` input is optional and narrows the grant. |
| `revoke(token)` | `POST /oauth/revoke` | `{ revoked: true }` |
| `userinfo(accessToken)` | `GET /oauth/userinfo` | The claims by scope |
| `registerOAuthClient({ issuer, clientName, redirectUris })` | `POST /oauth/register` | `{ clientId, redirectUris }` |

`OAUTH_CALLS` is the table of these routes and of the metadata document.

## The answers

Every call answers an `OAuthResult`: `{ ok: true, value }` or an `OAuthFailure` of `{ ok: false, code, status }`. The `code` is an `OAuthClientCode`: a code of the OAuth table, `network`, `unexpected`, `cancelled`, or `redirect_mismatch`.

- `handleRedirect` answers `redirect_mismatch` when the `state` matches no sign-in of this client, or when `iss` is not the issuer.
- It also answers `redirect_mismatch` when the URL is not on `redirectUri`.
- A sign-in waits at most `PENDING_TTL_MS`, 10 minutes. A later redirect answers `redirect_mismatch`.
- The `error` of a redirect, such as `access_denied`, comes with status 0. A code outside the OAuth table answers `unexpected`.
- A 200 answer of the wrong shape answers `unexpected`. Nothing throws for an answer.
- The client does not verify the ID token. Call `userinfo`, or verify the access token with [the verify package](/docs/reference/verify/).

## A single-page app

- A page on another origin needs that origin in a redirect URI of its client.
- The token request is a form post with no other header, so the browser sends no preflight.
- The register, revoke, and userinfo endpoints have no CORS for another origin.
- Keep the pending sign-in in `sessionStorage` with `browserPendingStore()`. The `StorageLike` type is the part of `sessionStorage` that it calls.
- Each new sign-in removes the pending sign-ins that are older than 10 minutes.

## Exports

| Export | What it is |
| --- | --- |
| `createOAuthClient`, `registerOAuthClient` | The client and the registration. |
| `memoryPendingStore`, `browserPendingStore`, `PENDING_TTL_MS` | The pending stores and the wait limit. A `PendingSignIn` is one record. |
| `makePkce`, `webCrypto`, `base64Url` | PKCE S256 and its codec. |
| `parseReturnedUrl` | The parser of a URL that a redirect brought back, which answers a `Returned`. It does not use `URL`, which Hermes lacks in part. |
| `OAUTH_CALLS` | The route table of the entry. |

| Area | Types |
| --- | --- |
| The client | `OAuthClient`, `OAuthClientOptions`, `OAuthTokens` |
| The pending sign-in | `PendingSignIn`, `PendingStore`, `StorageLike` |
| PKCE and the redirect | `PkceCrypto`, `Returned` |
| The answers | `OAuthClientCode`, `OAuthFailure`, `OAuthResult` |

## Next

- [Sign in from a third-party app](/docs/guides/third-party-app/)
- [The client package](/docs/reference/client/)
- [Error codes](/docs/reference/errors/)
