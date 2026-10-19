---
title: OpenAPI document
description: The OpenAPI 3.1 document of every route of core, with its security schemes, its tags, and its error shape.
type: reference
sources:
  - packages/core/src/openapi/document.ts
  - packages/core/src/openapi/schemes.ts
  - packages/core/src/openapi/features.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 25
  - docs/superpowers/plans/2026-10-14-11g-openapi.md
---

**For:** a developer who loads the API into a tool or a code generator.

**What it does:** this page describes the OpenAPI 3.1 document of the routes. [Routes](/docs/reference/routes/) holds the same routes, one anchor for each.

## Before you start

- Know the `basePath` and the `baseURL` of your deployment. [Configuration](/docs/reference/config/) lists both keys.

## The file

| Field | Value |
| --- | --- |
| URL | [`/docs/reference/openapi.json`](/docs/reference/openapi.json) |
| OpenAPI version | 3.1. The `openapi` key of the file names the patch |
| Docs version | The `info.version` key: the version of `@authtempo/core` that these docs describe. From the first minor version, each docs tree has its own copy |
| Features | Every feature, also each feature that is off by default |
| Server | `{origin}{basePath}`, with `basePath` set to `/auth` |
| Cross-origin read | The file answers with `access-control-allow-origin: *` and no credentials |

The file has one operation for each route. The operations follow the order of `ROUTES`, grouped by path: a GET and a POST of one path share one path item. The `operationId` of an operation is the anchor of its route on the routes page, and `externalDocs` links that anchor. The file holds no example value: no token, no cookie value, and no code.

A local tool, such as Scalar, Swagger UI, Postman, or Insomnia, opens the file on your machine. Set its server to your deployment.

The site has no console, no schema browser, and no request from the docs. A tool on another origin reads the file with no credential. An origin in `trustedOrigins` gets credentialed CORS headers on every route of a deployment, so the origin of a docs tool does not belong there.

## Security schemes

Each operation has one security requirement for each credential form that the route takes. A route that takes no credential has no requirement.

| Scheme | Type | Credential |
| --- | --- | --- |
| `sessionCookie` | `apiKey` | The session cookie, by the name of `cookieName` |
| `sessionBearer` | `http` | A session token as the bearer. It starts with `ts_` |
| `apiToken` | `http` | An API token as the bearer. It starts with `tk_` |
| `sessionJwt` | `http` | A session JWT as the bearer |
| `oauth` | `oauth2` | An access token of the OAuth provider, from the authorization code flow. A public client proves itself with PKCE (S256). A confidential client sends its secret, and may omit PKCE only when it asks `openid` with a `nonce` |
| `operatorSecret` | `apiKey` | The operator secret in the `Authorization` header, as `Operator <secret>`. `Operator` is not a registered HTTP authentication scheme |
| `initialAccessToken` | `http` | The initial access token of RFC 7591 as the bearer, for `POST /oauth/register` while `oauth.registration.initialAccessTokenHash` is set |
| `clientSecretBasic` | `http` | The client id and secret of a client with a secret, as HTTP Basic, for `POST /oauth/token` and `POST /oauth/revoke`. Each half is form-encoded first |

## Tags

The document has one tag for each feature. Each tag and each operation carry `x-authtempo-feature` and `x-authtempo-default`. "Always on" names a feature that every deployment serves.

| Tag | Config key | Default |
| --- | --- | --- |
| `session` | always on | on |
| `account` | always on | on |
| `accountDelete` | `account.delete` | on |
| `magicLink` | always on | on |
| `social` | `social` | off |
| `passkey` | `passkey` | off |
| `password` | `password` | off |
| `totp` | `totp` | off |
| `emailOtp` | `emailOtp` | on |
| `emailOtpReset` | `emailOtp` and `password` | off |
| `handoff` | `handoff` | off |
| `organizations` | `organizations` | off |
| `tokens` | always on | on |
| `jwtMint` | `jwtMint` | on |
| `operator` | `operator` | off |
| `oauth` | `oauth` | off |
| `oauthRegistration` | `oauth.registration.dynamic` | off |
| `openapi` | `openapi` | off |

## The error shape

| Schema | Shape | Used by |
| --- | --- | --- |
| `Error` | `{ error, message? }`. `message` is present only on `hook_refused` | A code of `ERRORS` |
| `OAuthError` | `{ error }` | A code of `OAUTH_ERRORS` |

Each operation has one response for each status of its codes, with an `enum` of those codes. Each code links its anchor on [Error codes](/docs/reference/errors/). Every operation also has two codes of the router, `not_found` and `internal`. Each POST also has `origin_not_trusted`, except Apple's form post callback, which takes a cross-site form.

## The route of a deployment

With `openapi: true`, core serves [`GET <basePath>/openapi.json`](/docs/reference/routes/#get-openapi-json). It answers the document of the routes that the config turns on, with `baseURL` as the server. The key is off by default. The answer carries the CORS headers of the router: a trusted origin gets them with credentials, and another origin gets none.

## Exports

`@authtempo/core/openapi` holds the generator and the contract of each route.

| Export | What it is |
| --- | --- |
| `openApiDocument` | The OpenAPI 3.1 document of a set of options. The same options give the same bytes. |
| `openApiJson` | The document as JSON, with a two-space indent and one newline at the end. |
| `OpenApiDoc` | The type of the document as plain JSON data. |
| `OpenApiOptions` | The six options of the document: `serverUrl`, `basePath`, `cookieName`, `features`, `scopes`, and `version`. |
| `openApiOptionsFrom` | The options of a resolved config: its deployment keys and the features of the routes that it mounts. |
| `openApiReferenceOptions` | The options of the file on this site: every feature, the default `basePath` and `cookieName`, the built-in scopes, and no server. |
| `deploymentOptions` | The five deployment keys of a resolved config: every option except `features`. |
| `FEATURE_INFO` | The config key and the default of each feature. |
| `featuresOf` | The features of a list of routes, read from the key of each route. |
| `ROUTE_CONTRACT` | The request and answer schemas of each route, by its key. |
| `RouteContract` | One row of `ROUTE_CONTRACT`. |
| `AnswerKind` | The kind of an answer and its fields: `json` with its schema, `html`, `redirect` with its error parameter, or `metadata`. |
| `AnswerOf`, `BodyOf`, `QueryOf` | The answer, the body, and the query type of a route, by its key. |

## Next

- [Routes](/docs/reference/routes/)
- [Error codes](/docs/reference/errors/)
