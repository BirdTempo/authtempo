---
title: Sessions, API tokens, and JWTs
description: The kinds of credential that core issues, what each one may do, and how core reads each from a request.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.1
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.8
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.12
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 12"
  - docs/superpowers/plans/2026-10-14-12b-security-hardening.md "Task 13"
---

**For:** a developer who must choose a credential for a browser, an app, a script, or another server.

**What it does:** this page compares the credentials of core and the rules that keep them apart.

## Before you start

- Read [Tokens and prefixes](/docs/reference/tokens/) for the form of each token.

## The kinds

| Credential | Who holds it | Where it travels | Life | Ends at a sign-out |
| --- | --- | --- | --- | --- |
| Session token, `ts_` | A browser or a native app | The session cookie, or the bearer header | 30 days by default, and a sliding refresh | Yes |
| API token, `tk_` | A script or a CLI | The bearer header only | 90 days by default, or no expiry | No |
| Session JWT | Another server of the app | Any header that the app chooses | 15 minutes by default | No |
| Access token, `at+jwt` | An OAuth client, such as an MCP client | The bearer header | `oauth.accessTtlMinutes` | No |
| Refresh token, `or_` | An OAuth client | The token endpoint only | 30 days by default, used once | No |

A session is fresh for `session.freshMinutes` after its sign-in or a re-authentication. [Fresh sessions](/docs/concepts/fresh-sessions/) tells which changes need a fresh session.

## A session

A session is a row. Its token is the person's key to the API. A browser sends it in the `HttpOnly` cookie, and a native app sends it as the bearer. Core stores its SHA-256 only.

By default the cookie is `__Host-tempo_session`. A session can have an absolute lifetime, `session.absoluteDays`, after which the person signs in again. [Cookies](/docs/reference/cookies/) lists each cookie.

Every core route that needs a person calls `auth.session`, which reads sessions only. So an API token, a JWT, and an access token cannot create a token, change a password, or touch passkeys or organizations.

A session row holds a flag, `proved`. It is true when the session came after the proof of its address, or when its user has no address and is not anonymous. Each verified-only action reads it with the user row. So a session that came before the proof of its address never gains verified powers. [The session proof](/docs/concepts/claim-rule/#the-session-proof) tells the rule.

## An API token

An API token is a credential of one verified user, never a session. Only a person with a proved session creates or revokes one. It counts only in the bearer header, because a browser sends a cookie on a cross-site request. A token may name one organization. When the user leaves that organization, the token stops, and the list still shows it.

A password reset, a password change, and a sign-out delete no API token.

## A session JWT

A session JWT is a signed statement about the session user, for a server that cannot call `auth.session`. Its `email_verified` claim is true only when the session is proved and the address is verified. The other server checks it against the public keys at `/auth/jwks`. It lives to its `exp`, so keep its life short. A server that must end access at a sign-out checks the `sid` claim with `api.jwt.sessionLive`.

## An access token

An access token is a JWT for one resource. Core signs it with the same key as a session JWT, with the header `typ: "at+jwt"`. It passes only under the resource in its `aud`. An access token cannot be revoked, so it ends at its `exp`.

## How core reads a request

`auth.caller(request)` answers the caller of any kind:

1. A present session cookie wins, and resolves as a session only.
2. Else the bearer header decides by its form.
3. A `ts_` bearer resolves as a session, and a `tk_` bearer as an API token.
4. A JWT bearer resolves as an access token, under the resource of the request URL. A `client_credentials` token answers `kind: "oauth-client"`: it acts for a client and has no user.
5. Any other request answers null.

`auth.session(request)` answers sessions only. Use `caller` in a route that a script or an agent may call. Use `session` in a route for people.

## Next

- [Give a script an API token](/docs/guides/api-tokens/)
- [Mint a JWT for your other services](/docs/guides/jwt/)
- [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/)
