---
title: Tokens and prefixes
description: Every token that core makes, with its prefix, where it travels, its life, and how core stores it.
type: reference
sources:
  - packages/core/src/primitives/credentials.ts
---

**For:** a developer who sees a token in a log, a URL, or a store, and must know what it is.

**What it does:** this page lists each token kind by its prefix. A clear token appears once. Core stores the SHA-256 of each token, never the token.

## Before you start

- Read [Sessions, API tokens, and JWTs](/docs/concepts/credentials/) for the difference between the credentials.

## The prefixes

Each token is the prefix plus 43 base64url characters of 32 random bytes.

| Prefix | Token | Where it travels | Life |
| --- | --- | --- | --- |
| `ts_` | Session token | The session cookie, or the bearer header of a native app | `session.ttlDays` |
| `tk_` | API token | The bearer header only | `expiresInDays`, or none |
| `to_` | Organization token. It belongs to an organization, not to a person | The bearer header only | `expiresInDays`, or none |
| `ml_` | Magic link token | The link in the mail, then the confirm form | `magicLink.ttlMinutes` |
| `pv_` | Password verify token | The verify link in the mail | `magicLink.ttlMinutes` |
| `sp_` | Sign-up proof | The password sign-up answer, and the cookie `__Host-tempo_signup` | The life of the verify link or code |
| `pr_` | Password reset token | The reset link in the mail | `password.resetTtlMinutes` |
| `os_` | Social state | The `state` parameter at the provider | 10 minutes |
| `hs_` | Handoff id | The URLs of the handoff pages | 10 minutes, or `magicLink.ttlMinutes` when that is longer |
| `hc_` | Handoff code | The redirect to the app, then the redeem body | 2 minutes |
| `tf_` | Second factor challenge | The sign-in answer, then the verify body | 5 minutes |
| `td_` | Trusted device token | The trust cookie | `totp.trustDays` |
| `inv_` | Invitation token | The link in the invitation mail. No answer of a route carries it. | `organizations.invitationTtlDays` |
| `cl_` | OAuth client id | Every OAuth request of a registered client | 90 days unseen, with no consent and no refresh token. A client of `api.oauth.clients.create` lives until you delete it |
| `oc_` | OAuth authorization code | The redirect to the client, then the token body | `oauth.codeTtlMinutes` |
| `or_` | OAuth refresh token | The token answer and the token body | `oauth.refreshTtlDays` |
| `oq_` | OAuth held request id | The `request_id` of the sign-in page and the consent page | 10 minutes |

A client id may also be the https URL of its metadata document. Such an id has no prefix.

A key of `tokens.movedPrefixes`, such as `laaa_`, is a key that moved into core's token table from another system. Core looks up its hash as an API token. A moved key with no row answers `token_retired`.

## Tokens with no prefix

| Token | What it is |
| --- | --- |
| Session JWT | A JWT with `typ: "JWT"`, signed with the key of `/jwks`. It lives `jwtMint.ttlMinutes`, and a sign-out does not end it. |
| OAuth access token | A JWT with `typ: "at+jwt"` and `aud` the resource. It lives `oauth.accessTtlMinutes`, and nobody can revoke it. |
| ID token | A JWT of OpenID Connect for the client, with `nonce` when the client sent one. |
| Email code | 6 or 8 digits. Core stores HMAC-SHA256 under `secret` of the row id and the code. |
| Backup code | `totp.backupCodeLength` characters. Core stores HMAC-SHA256 under `secret`. |

## Next

- [Cookies](/docs/reference/cookies/)
- [Give a script an API token](/docs/guides/api-tokens/)
- [Key rotation](/docs/operations/key-rotation/)
