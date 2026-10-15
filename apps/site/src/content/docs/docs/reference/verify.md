---
title: The verify package
description: The options, the caller kinds, the answers, and every export of @authtempo/verify.
type: reference
sources:
  - packages/verify/README.md "The caller kinds"
  - packages/verify/README.md "Options"
  - packages/verify/README.md "The rules"
  - packages/verify/README.md "The 401 and the 403"
  - packages/verify/src/index.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.12
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 20
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
---

**For:** a developer of a server that is not the auth app and must know the caller of a request.

**What it does:** this page lists the options of `createVerifier`, the four caller kinds, the answers, and every export of the package. The export check holds this page to `packages/verify/src/index.ts`.

## Before you start

- Read [Mint a JWT for your other services](/docs/guides/jwt/) for the session JWT that the auth app mints.

## Options

`createVerifier(options)` answers a `Verifier`. The type of the options is `VerifierOptions`. A wrong option throws at construction.

| Option | Default | What it does |
| --- | --- | --- |
| `issuer` | required | `baseURL` plus `basePath` of the auth app: the `iss` of its tokens. An http or https URL with no query, fragment, or user info. |
| `audience` | none | The `jwtMint.audience` entry or entries of this server, 1 to 10. Required for `session-jwt`. |
| `resources` | none | The `oauth.resources` entries that this server serves. Required for `oauth`. |
| `accept` | `["session-jwt"]` | The caller kinds to accept, of the type `CallerKind`. |
| `checkSessionEnd` | `false` | Asks `POST /token/live` for each session JWT, so a sign-out ends access at once. |
| `cache` | `{ apiTokenSeconds: 0 }` | How long an API token answer is kept: 0 to `API_TOKEN_CACHE_MAX_SECONDS` (60) seconds. |
| `timeoutMs` | `TIMEOUT_DEFAULT_MS` (5000) | The deadline of each call to the auth app, from `TIMEOUT_MIN_MS` (100) to `TIMEOUT_MAX_MS` (30000). |
| `fetch` | `globalThis.fetch` | The fetch of every call to the auth app. Any function of a request and its init that answers a `Response`. |
| `clock` | the system clock | Tests inject one. |

A URL that is both an `audience` entry and a `resources` entry is refused: one key signs both kinds of token.

**Warning: an `http:` issuer is accepted on any host.** The verifier then reads the key set and sends each bearer over plain HTTP. Use `https:` outside local development.

## The caller kinds

`verifier.verifyRequest(request)` answers a `VerifyResult`: `{ ok: true, value }` with a `Caller` or `null`, or a failure.

| Kind | The credential | The check | The fields |
| --- | --- | --- | --- |
| `session-jwt` | A session JWT, header `typ` `JWT` | Offline: the signature, `iss`, `sub`, `sid`, `aud`, and `exp` | `userId`, `sessionId`, `email`, `emailVerified`, `name`, `organizationId`, `claims`, `expiresAt` |
| `oauth` | An access token, header `typ` `at+jwt` | Offline: the signature, `iss`, `sub`, `client_id`, `scope`, `jti`, and `exp`. `aud` must be the resource that the request URL falls under | `userId`, `clientId`, `scopes`, `resource`, `tokenId`, `expiresAt` |
| `api-token` | A `tk_` bearer token | One call to `GET /tokens/current` | `user`, `apiToken` |
| `session-token` | A `ts_` bearer token | One call to `GET /session`. Each check can extend the session, as a visit does. | `user`, `session` |

A kind that `accept` does not list answers `null` with no call.

The verifier reads the `Authorization` header only. It never reads the session cookie, whose default name is `__Host-tempo_session`. A request with only the cookie answers `null` with no call.

## The answers

- A bad, expired, or foreign credential answers `{ ok: true, value: null }`.
- A key set or an auth app that does not answer gives a failure with `network` or `unexpected`, never `null`. Answer 503, not 401.
- A 200 answer whose shape is not the shape of core gives `unexpected` with status 200.
- No call follows a redirect. A 3xx answer gives `unexpected`. A call with no answer before `timeoutMs` gives `network`.
- With `checkSessionEnd`, the live route counts on `token-live:session:<sessionId>`, 120 per minute ([Limits](/docs/reference/limits/)). A full count gives the failure `rate_limited` with status 429.
- An offline check of an access token does not see a deleted user. `auth.caller` of core does.

## The key set

- The key set lives for the `max-age` of its answer: at least `KEY_SET_MIN_SECONDS` (60), at most `KEY_SET_MAX_SECONDS` (3600). With no `max-age`, it lives `KEY_SET_DEFAULT_SECONDS` (300).
- An unknown `kid` reads the key set again at most once per `UNKNOWN_KID_EVERY_MS` (30 seconds).
- After a failed read, the verifier answers the same failure for `FAILED_READ_PAUSE_MS` (5 seconds) with no read.
- A body over `KEY_SET_MAX_BYTES` (64 KiB) gives `unexpected`. A set of more than `KEY_SET_MAX_KEYS` keys gives `unexpected` too.
- `KEY_SET_MAX_KEYS` is `JWKS_RETIRED_MAX` plus 1: the signing key and the retired keys that core can list.
- Core keeps a retired key in its set for 24 hours. A token of a rotated key verifies until its `exp`.
- The check runs on Web Crypto with the code of `@authtempo/core/credentials`, the same code as core.

## The 401 and the 403

- `verifier.unauthorized({ resource, scope })` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. An MCP client reads the protected-resource document and the scopes to ask for.
- `invalidToken: true` adds `error="invalid_token"`. Pass it when the request held a token that you refused.
- `verifier.insufficientScope({ resource, scope, description })` answers 403 with `error="insufficient_scope"`. Name every scope of the operation in one challenge.
- A scope with a quote, or `offline_access`, throws: `offline_access` is not a resource scope.
- The input of both is a `ChallengeInput`.

## Exports

| Export | What it is |
| --- | --- |
| `createVerifier` | Makes a `Verifier`. |
| `VERIFY_CALLS` | The table of the routes that the verifier calls. `VerifyOperation` is the type of its operation names. |
| `KEY_SET_DEFAULT_SECONDS`, `KEY_SET_MIN_SECONDS`, `KEY_SET_MAX_SECONDS` | The life of the key set. |
| `UNKNOWN_KID_EVERY_MS`, `FAILED_READ_PAUSE_MS` | The two waits between reads of the key set. |
| `KEY_SET_MAX_BYTES`, `KEY_SET_MAX_KEYS` | The two caps of the key set. |
| `TIMEOUT_DEFAULT_MS`, `TIMEOUT_MIN_MS`, `TIMEOUT_MAX_MS` | The default and the range of `timeoutMs`. |
| `API_TOKEN_CACHE_MAX_SECONDS` | The longest API token cache. |
| `unauthorizedResponse`, `insufficientScopeResponse`, `bearerChallenge` | The 401, the 403, and the challenge text, with no verifier. A server that checks the caller with `auth.caller` uses them. |

The types: `Verifier`, `VerifierOptions`, `VerifyResult`, `Caller`, `CallerKind`, `ChallengeInput`, `VerifyOperation`.

## Next

- [Verify a caller on another server](/docs/guides/verify-caller/)
- [Routes](/docs/reference/routes/)
- [Limits](/docs/reference/limits/)
