# @authtempo/verify

This package tells a server that is not the auth app who the caller is. It
reads the `Authorization` header and answers a caller, null, or a failure. A
resource server never reads the session cookie: this package reads the bearer
only. Its dependencies are `@authtempo/client` and `@authtempo/core`. It runs
on Workers, Node 22.18 or newer, and Bun; it imports no Node module.

## Install

When the package is published, run `pnpm add @authtempo/verify`.
Publication is on hold. In this workspace, add it with `"workspace:*"`.

## Verify a request

```ts
import { createVerifier } from "@authtempo/verify";

const verifier = createVerifier({
  issuer: "https://api.example.com/auth",
  audience: "https://files.example.com",
});

const r = await verifier.verifyRequest(request);
if (!r.ok) return new Response("try again", { status: 503 });
if (r.value === null) return verifier.unauthorized();
```

## The caller kinds

| Kind | The credential | How it is checked |
| --- | --- | --- |
| `session-jwt` | A session JWT, `typ: "JWT"` | Offline: the signature against the key set, `iss`, `sub`, `sid`, `aud` (one of `audience`), and `exp` |
| `oauth` | An access token, `typ: "at+jwt"` | Offline: as above, and `aud` must be the entry of `resources` that the request URL falls under |
| `api-token` | A `tk_` bearer | One `GET <basePath>/tokens/current`; `cache.apiTokenSeconds` (0 to 60, default 0) keeps the answer |
| `session-token` | A `ts_` bearer | One `GET <basePath>/session`. Off by default: it sends the person's session token to the auth app |

`accept` lists the kinds to accept; the default is `["session-jwt"]`. A kind
that `accept` does not list answers null with no network call.

## Options

| Option | Default | Range | What it does |
| --- | --- | --- | --- |
| `issuer` | none | an http or https URL with no query | `baseURL + basePath` of the auth app, the `iss` of its tokens. |
| `audience` | none | 1 to 10 strings of 1 to 2048 characters | The `jwtMint.audience` entries of this server. Needed for `session-jwt`. |
| `resources` | none | resource URLs, the rule of `oauth.resources` | The `oauth.resources` entries that this server serves. Needed for `oauth`. |
| `accept` | `["session-jwt"]` | one or more kinds | The kinds to accept. |
| `checkSessionEnd` | `false` | a boolean | Ask the live route for each session JWT. |
| `cache.apiTokenSeconds` | 0 | an integer from 0 to 60 | How long a `tk_` answer is kept. |
| `timeoutMs` | 5000 | an integer from 100 to 30000 | The deadline of each call to the auth app, and of the read of its body. |
| `fetch` | the global `fetch` | a fetch function | Tests give a stub. |

`createVerifier` throws for a wrong config: an issuer that is not a URL, no
`audience` for `session-jwt`, no `resources` for `oauth`, a resource that
core's resource rule refuses, a URL that is both an audience and a resource,
or a number outside its range. A malformed resource throws at construction,
not at each request.

## The rules

- A bad, expired, or foreign credential answers `{ ok: true, value: null }`.
- A key set or an auth app that does not answer gives `network` or
  `unexpected`, never null. Answer 503, not 401.
- No call follows a redirect. A 3xx answer gives `unexpected` with its
  status. A call with no answer within `timeoutMs` gives `network`.
- The claim rule is a copy of core's rule, and a test holds the two copies
  equal. `exp` is strict: a token is refused at the second of its `exp`,
  with no clock skew.
- The key set lives for the `max-age` of its answer (core sends 300 s, at
  most 3600 s). An unknown `kid` reads it again at most once per 30 s.
- Each key of the set is checked when it is read: `kty`, `crv`, and `alg`
  must be OKP, Ed25519, and EdDSA, or EC, P-256, and ES256, and `use` must be
  `sig`. A key that fails is dropped, so a token that it signed answers null.
- Core keeps a retired key in the set for 24 hours, so a token signed before
  a rotation verifies until its `exp`.
- A session JWT stays a bearer after a sign-out. With `checkSessionEnd: true`
  the verifier asks `POST <basePath>/token/live` for each session JWT, and a
  sign-out ends access at once. That route counts on
  `token-live:session:<sessionId>`, 120 per 60 s; above it the verifier
  answers `rate_limited` with status 429.
- An offline access token check does not see a deleted user; core's
  `auth.caller` does.

## The 401 and the 403

- `verifier.unauthorized({ resource, scope })` answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. An MCP client
  reads the protected-resource document and the scopes to ask for from it.
  Add `invalidToken: true` when the request held a token that you refused.
- `verifier.insufficientScope({ resource, scope })` answers 403
  `insufficient_scope`. Name every scope of the operation in one challenge.
- `offline_access` is not a resource scope: the functions refuse it.
- `unauthorizedResponse`, `insufficientScopeResponse`, and `bearerChallenge`
  do the same with no verifier, for a server that checks the caller with
  `auth.caller` of core.
