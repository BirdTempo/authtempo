# @authtempo/verify

This package tells a server that is not the auth app who the caller is. It
reads the `Authorization` header and answers a caller, null, or a failure. A
resource server never reads the session cookie: this package reads the bearer
only. Its dependencies are `@authtempo/client` and `@authtempo/core`. It runs
on Workers, Node 22.18 or newer, and Bun; it imports no Node module.

## Install

Run `pnpm add @authtempo/verify`.

## Verify a request

```ts
import { createVerifier } from "@authtempo/verify";

const verifier = createVerifier({
  issuer: "https://api.example.com/auth",
  audience: "https://files.example.com",
});

const r = await verifier.verifyRequest(request);
if (!r.ok) return new Response("try again", { status: 503 });
// The verifier reads the scheme of the request, so a refused token gets its error.
if (r.value === null) return verifier.unauthorized({ request });
```

## The caller kinds

| Kind | The credential | The check |
| --- | --- | --- |
| `session-jwt` | A session JWT, `typ: "JWT"` | Offline: the signature against the key set, `iss`, `sub`, `sid`, `aud` (one of `audience`), and `exp` |
| `oauth` | An access token of a person, `typ: "at+jwt"` | Offline: the signature against the key set, `iss`, `sub`, `client_id`, `scope`, `jti`, and `exp`. `aud` must be the entry of `resources` that the request URL falls under. `dpopJkt` is the key of a DPoP request, else null |
| `oauth-client` | An access token of the `client_credentials` grant, whose `sub` is its `client_id` | The checks of `oauth`. The caller has no `userId`: the client acts for no person |
| `api-token` | A `tk_` bearer, or a moved key with `movedKind` `"api-token"` | One `GET <basePath>/tokens/current`; `cache.apiTokenSeconds` (0 to 60, default 0) keeps the answer |
| `organization-token` | A `to_` bearer, or a moved key with `movedKind` `"organization-token"` | One `GET <basePath>/organizations/tokens/current`. The answer is never kept. The caller has `organization` and `apiToken`, and no user |
| `session-token` | A `ts_` bearer | One `GET <basePath>/session`. Off by default: it sends the person's session token to the auth app. Each check can extend the person's session, as a visit does |

The `userId` of an `oauth` caller is the token's `sub`. That is the user id
for a public client, and the pairwise subject (`ps_…`) for a pairwise
client. Core's `auth.caller` names the same value `subject`, beside the
user.

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
| `movedPrefixes` | none | entries of core's `tokens.movedPrefixes` rule, each once | The prefixes of keys that moved into core's token tables, such as `laaa_`. A bearer with one goes to the route of `movedKind`. Without it, a moved key answers null with no call. |
| `movedKind` | `"api-token"` | `"api-token"` or `"organization-token"` | The kind of every moved key: the app's Better Auth `references`. It must be in `accept` while `movedPrefixes` has an entry. |
| `timeoutMs` | 5000 | an integer from 100 to 30000 | The deadline of each call to the auth app, and of the read of its body. |
| `fetch` | the global `fetch` | a fetch function | Tests give a stub. |
| `dpop` | none | see "DPoP" | Accept `Authorization: DPoP` with a proof. |
| `introspect` | none | `{ clientId, clientSecret }` | Ask `POST <basePath>/oauth/introspect` about each access token. |

`createVerifier` throws for a wrong config:

- an issuer that is not an http or https URL, or that has a query, a
  fragment, or user info;
- no `audience` for `session-jwt`, or no `resources` for `oauth` or
  `oauth-client`;
- `dpop` or `introspect` without `oauth` or `oauth-client` in `accept`;
- a resource that core's resource rule refuses;
- a moved prefix that core's `tokens.movedPrefixes` rule refuses, a repeated one, or a `movedKind` that `accept` does not list;
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

## DPoP

With `dpop`, the verifier reads `Authorization: DPoP <token>` and the `DPoP`
header of RFC 9449. The check runs offline with `checkDpopProof` of
`@authtempo/core/credentials`, the same code as core's `auth.caller`.

| Option | Default | What it does |
| --- | --- | --- |
| `dpop.algs` | all of `FOREIGN_ALGS` | The algs of a proof, as `oauth.dpop.algs` of core. |
| `dpop.windowSeconds` | 60 | How far the `iat` of a proof may be from now, 10 to 300. |
| `dpop.replay` | `memoryReplayStore()` | The store of the proofs seen: `seen(key, ttlSeconds)`. |
| `dpop.required` | `false` | True: an access token without the DPoP scheme answers null. |

- The token must be bound (`cnf.jkt`), and the proof key must have that
  thumbprint. The proof must hold `ath`, the method, and the URL.
- A bound token sent as a Bearer answers null (RFC 9449 section 7.2).
- The proof is checked last, so a request that fails another check spends
  no proof. A second `verifyRequest` of one request answers the same.
- Each proof key lives in the store to `ceil(iat)` plus twice the window.
- The default store sees a replay only inside one isolate. A deployment with several isolates passes a shared store, or uses `auth.caller`, whose store is the database.
- `memoryReplayStore(max)` keeps at most `max` keys, 10,000 by default
  (`REPLAY_STORE_DEFAULT_MAX`). Above the bound it drops the oldest key.
- A store that throws gives `network`, never null.

## Introspection

With `introspect`, each access token that passes the offline check costs one
call to `POST <basePath>/oauth/introspect` (RFC 7662). A bad token costs no
call. The verifier sends `client_secret_basic`: the form-encoded id and
secret (RFC 6749 section 2.3.1). The client must be a confidential client of
the auth app with `introspect: true`.

- `active: false` answers null, so a revoked grant ends access at once.
- An auth app with two or more `oauth.resources` must name this client in
  `oauth.introspection` (RFC 7662 section 4). Without that entry, core
  answers `active: false`, and the verifier answers null for every token.
- Core counts each call on `oauth-introspect:ip:<ip>` and
  `oauth-introspect:client:<clientId>`, 600 per 60 s each. Each request
  costs one call. Above about 10 requests per second the verifier gets 429,
  so it answers `unexpected`, and `requireMcpAuth` answers 503.
- A call with no answer gives `network`. A status other than 200 gives
  `unexpected` with that status. A body with no boolean `active`, or a body
  over `INTROSPECT_MAX_BYTES` (64 KiB), gives `unexpected` with status 200.

## The 401 and the 403

- `verifier.unauthorized({ resource, scope })` answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. An MCP client
  reads the protected-resource document and the scopes to ask for from it.
  Add `invalidToken: true` when the request held a token that you refused.
- Pass `request` in place of `invalidToken`. The verifier then reads the
  scheme of the request. The error goes into the challenge of that scheme
  (RFC 9449 section 7.2).
- A verifier with no `dpop` does not read the DPoP scheme. It answers a
  DPoP request with the plain challenge and no error code (RFC 6750
  section 3.1).
- With `dpop`, a `DPoP` challenge follows the `Bearer` one:
  `DPoP algs="…", resource_metadata="…"`. A refused proof adds
  `error="invalid_dpop_proof"`, and a refused DPoP token adds
  `error="invalid_token"`. `dpopChallenge` writes the text alone.
- The verifier keeps the result of each proof check by the request, and the
  signature of each refused proof. A clone of a refused request then gets
  its error too. Pass the request that `verifyRequest` read, or a clone.
- `verifier.insufficientScope({ resource, scope })` answers 403
  `insufficient_scope`. Name every scope of the operation in one challenge.
  With `dpop` and a DPoP `request`, the `DPoP` challenge carries the error,
  with `algs`, `resource_metadata`, and `scope`.
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

`caller.userId` is the token's subject at both sources: the user id for a
public client, the pairwise subject for a pairwise client. So a server that
moves from one source to the other keeps its data keys.

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

- A DPoP request passes through the wrapper with no new option. A `Verifier`
  source needs `dpop`; core's `auth` reads the DPoP scheme itself.
- The wrapper checks one proof per request, so a second request with the
  same proof gets 401. With a `Verifier` source, the 401 and the 403 come
  from `verifier.unauthorized` and `verifier.insufficientScope` with the
  request.
- Core's `auth` gives the wrapper no algs. For a DPoP request, that source
  writes the `DPoP` challenge with no `algs`, a SHOULD of RFC 9449. That
  challenge follows the `Bearer` one in a 401, and stands alone in a 403.
- A token of the `client_credentials` grant gets 401: the wrapper needs a
  person.
