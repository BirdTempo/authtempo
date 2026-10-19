# @authtempo/verify

This package tells a server that is not the auth app who the caller is. It
reads the `Authorization` header and answers a caller, null, or a failure. A
resource server never reads the session cookie: this package reads the bearer
only. Its dependencies are `@authtempo/client` and `@authtempo/core`. It runs
on Workers, Node 22.18 or newer, and Bun; it imports no Node module.

## Install

When the package is on npm, run `pnpm add @authtempo/verify`.
Publication is on hold. In this workspace, add it with `"workspace:*"`.

## Verify a request

```ts
import { readBearer } from "@authtempo/core/credentials";
import { createVerifier } from "@authtempo/verify";

const verifier = createVerifier({
  issuer: "https://api.example.com/auth",
  audience: "https://files.example.com",
});

const r = await verifier.verifyRequest(request);
if (!r.ok) return new Response("try again", { status: 503 });
// invalidToken: the request held a bearer, and the verifier refused it.
if (r.value === null) return verifier.unauthorized({ invalidToken: readBearer(request) !== null });
```

## The caller kinds

| Kind | The credential | The check |
| --- | --- | --- |
| `session-jwt` | A session JWT, `typ: "JWT"` | Offline: the signature against the key set, `iss`, `sub`, `sid`, `aud` (one of `audience`), and `exp` |
| `oauth` | An access token, `typ: "at+jwt"` | Offline: the signature against the key set, `iss`, `sub`, `client_id`, `scope`, `jti`, and `exp`. `aud` must be the entry of `resources` that the request URL falls under |
| `api-token` | A `tk_` bearer | One `GET <basePath>/tokens/current`; `cache.apiTokenSeconds` (0 to 60, default 0) keeps the answer |
| `session-token` | A `ts_` bearer | One `GET <basePath>/session`. Off by default: it sends the person's session token to the auth app. Each check can extend the person's session, as a visit does |

`accept` lists the kinds to accept; the default is `["session-jwt"]`. A kind
that `accept` does not list answers null with no network call.

## Options

| Option | Default | Range | What it does |
| --- | --- | --- | --- |
| `issuer` | none | an http or https URL with no query, fragment, or user info | `baseURL + basePath` of the auth app, the `iss` of its tokens. |
| `audience` | none | 1 to 10 strings of 1 to 2048 characters | The `jwtMint.audience` entries of this server. Needed for `session-jwt`. |
| `resources` | none | resource URLs, the rule of `oauth.resources` | The `oauth.resources` entries that this server serves. Needed for `oauth`. |
| `accept` | `["session-jwt"]` | one or more kinds | The kinds to accept. |
| `checkSessionEnd` | `false` | a boolean | Ask the live route for each session JWT. |
| `cache.apiTokenSeconds` | 0 | an integer from 0 to 60 | How long the verifier keeps a `tk_` answer. |
| `timeoutMs` | 5000 | an integer from 100 to 30000 | The deadline of each call to the auth app, and of the read of its body. |
| `fetch` | the global `fetch` | a fetch function | Tests give a stub. |

`createVerifier` throws for a wrong config:

- an issuer that is not an http or https URL, or that has a query, a
  fragment, or user info;
- no `audience` for `session-jwt`, or no `resources` for `oauth`;
- a resource that core's resource rule refuses;
- a URL that is both an audience and a resource;
- a number outside its range.

A malformed resource throws at construction, not at each request.

**Warning: the verifier accepts an `http:` issuer on any host.** It then
reads the key set and sends each bearer over plain HTTP. Core accepts an
`http:` `baseURL` on any host too. Use `https:` outside local development.

## The rules

- A bad, expired, or foreign credential answers `{ ok: true, value: null }`.
- A key set or an auth app that does not answer gives `network` or
  `unexpected`, never null. Answer 503, not 401.
- A 200 answer of the auth app whose shape is not core's gives `unexpected`
  with status 200. The verifier checks the `id` of each object that it reads.
- No call follows a redirect. A 3xx answer gives `unexpected` with its
  status. A call with no answer within `timeoutMs` gives `network`.
- The claim rule is a copy of core's rule, and a test holds the two copies
  equal. `exp` is strict: the verifier refuses a token at the second of its
  `exp`, with no clock skew.
- The key set lives for the `max-age` of its answer. Core sends 300 s. The
  verifier keeps the set at least 60 s and at most 3600 s.
- An unknown `kid` reads the key set again at most once per 30 s.
- After a failed read of the key set, the verifier answers the same failure
  for 5 s with no read. An outage then costs one read per 5 s, not one read
  per request.
- A key set body over 64 KiB gives `unexpected`. A set of more keys than
  core can list gives `unexpected` too. Core lists the signing key and at
  most `JWKS_RETIRED_MAX` retired keys: 101 keys today. Under RS256 that set
  is 43,945 bytes (measured 2026-10-19), and the cap is about 1.49 times it.
- The verifier checks each key of the set when it reads the set, with
  `isPublicJwk` of `@authtempo/core/credentials`. `kty`, `crv`, and `alg`
  must be OKP, Ed25519, and EdDSA; EC, P-256, and ES256; or RSA and RS256.
  An RSA modulus must hold at least 2048 bits. A key with a private member
  (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, or `k`) fails. A key may leave
  out `use`; when it has one, the value must be `sig`. A key may leave out
  `key_ops`; when it has one, the list must hold `verify`. The verifier drops
  a key that fails, so a token that the key signed answers null.
- Core keeps a retired key in the set for 24 hours, so a token that core
  signed before a rotation verifies until its `exp`.
- A session JWT stays a bearer after a sign-out. With `checkSessionEnd: true`
  the verifier asks `POST <basePath>/token/live` for each session JWT, and a
  sign-out ends access at once.
- That route counts on `token-live:session:<sessionId>`, 120 per 60 s. Every
  resource server of one person shares this budget, because the key is the
  session. Above it the verifier answers `rate_limited` with status 429.
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

## Protect an MCP server

The entry `@authtempo/verify/mcp` wraps the handler of an app's own MCP
route. The handler runs only for an OAuth access token of the route's
resource that holds every scope of the route.

```ts
import { createVerifier } from "@authtempo/verify";
import { McpScopeError, requireMcpAuth } from "@authtempo/verify/mcp";

const verifier = createVerifier({
  issuer: "https://api.example.com/auth",
  resources: ["https://api.example.com/mcp"],
  accept: ["oauth"],
});

export const mcp = requireMcpAuth(
  verifier,
  async (request, caller) => {
    // A tool that needs more: throw, and the wrapper answers 403 for these scopes.
    if (!caller.scopes.includes("mcp:write")) throw new McpScopeError(["mcp:tools", "mcp:write"]);
    return Response.json({ user: caller.userId });
  },
  { resource: "https://api.example.com/mcp", scopes: ["mcp:tools"] },
);
```

The source is one of two:

- A `Verifier` of this package, for a server that is not the auth app. The
  wrapper uses it when the source has `verifyRequest`.
- Core's `auth`, for an MCP route in the same Worker or process as the auth
  app. The wrapper calls `auth.caller`. This source fetches no key set, so no
  Worker must fetch its own JWKS on its own host.

The rules:

- Construction throws when `resource` is not `https:`. It accepts `http:`
  only on `127.0.0.1` or `localhost`. It also throws for a query, a fragment,
  or user info in it: the resource rule of core.
- Construction throws for a scope that the challenge refuses:
  `offline_access`, a quote, a space, or an empty list.
- No bearer gives 401 with the challenge of `resource` and
  `challengeScopes`, or `scopes` when `challengeScopes` is not set. A session
  cookie is no credential here.
- A bearer that is not an OAuth access token gives the same 401 with
  `error="invalid_token"`. A session, a session JWT, and an API token are not.
- A token for another resource of the same issuer gives the 401 of
  `error="invalid_token"`.
- A caller without every entry of `scopes` gives 403 `insufficient_scope`.
  The challenge names every scope of the route, not only the missing ones.
- A source that fails gives 503 with no body, never 401. A failure is a
  `Verifier` answer of `network` or `unexpected`, or a throw of `caller`.
- A `McpScopeError` of the handler gives 403 for its scopes. Any other throw
  passes through.
- A caller that passes gets the handler's answer, unchanged.

DPoP and token introspection come with row 12e, through the `Verifier`, with
no new call.
