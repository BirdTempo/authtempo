---
title: Glossary
description: The approved term for each concept of authtempo, and the words that the docs do not use.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 18
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 3"
---

**For:** a reader or a writer of these docs who needs the meaning of a term.

**What it does:** this page gives one approved term for each concept. The docs use only that term.

## Before you start

- Nothing. This page is the start of the reference. The [docs home](/docs/) lists every section.

## Terms

| Approved term | Meaning | Do not write |
| --- | --- | --- |
| sign in, sign-in | The act that opens a session for a person. | `log in`, `login`, `logon` |
| sign out | The act that ends the current session. | `log out`, `logout` |
| session | A row that holds one signed-in browser or device. It ends at its expiry or at a sign-out. | |
| session token | The secret of a session: `ts_` plus 43 base64url characters. Core stores its SHA-256 only. | `session id`, `session key` |
| session cookie | The `HttpOnly` cookie that carries the session token in a browser. The default name is `__Host-tempo_session`. | |
| bearer token | A session token or an API token in the `Authorization: Bearer` header. | |
| magic link | A single-use link by mail that signs a person in. | |
| email code | A code of 6 or 8 digits by mail that signs a person in or resets a password. | `OTP` |
| passkey | A key pair on the person's device that signs a WebAuthn challenge. | `WebAuthn credential` |
| password | A secret that the person types. Core stores a PBKDF2 hash of it. | |
| second factor | A second proof after the first sign-in method: a TOTP code, a passkey, an email code, or a backup code. | `2FA`, `MFA`, `two-factor` |
| backup code | A single-use code that replaces a TOTP code once. | |
| trusted device | A browser or an app that skips the second factor until its expiry. | |
| challenge | The `tf_` token of a sign-in or a reset that waits for the second factor. | |
| provider | A service that signs a person in for the app, such as Google, Apple, or GitHub. | `IdP`, `identity provider` |
| social sign-in | A sign-in through a provider. | |
| identity | A row that joins a user to one provider and the provider's subject. | |
| proof of an address | A magic link, an email code, a reset, the verify link, or a provider that says that the person owns the address. | `email verification token` |
| claim | An account that a person made with an address that nobody proved. A proof of the address ends the claim. | |
| claim rule | The rule that a proof of an address deletes the other credentials and the sessions of a claimed account. | |
| handoff | A sign-in of a native or desktop app through the system browser, with a one-time code and a PKCE verifier. | |
| API token | A credential of one verified user for a script or a CLI: `tk_` plus 43 characters. It is never a session. | `API key` |
| session JWT | A signed statement about a session user, for a server that cannot call `auth.session`. | |
| access token | A JWT with `typ: "at+jwt"` that core issues to an OAuth client for one resource. | |
| refresh token | An `or_` token that an OAuth client trades for a new access token once. | |
| OAuth client | An app, an agent, or an MCP client that asks for access in the person's name. | |
| resource | A URL of the app that an access token is for, one of `oauth.resources`. | |
| consent | The decision of a person to give a client the scopes that it asks for. | |
| organization | A group of users with ranked roles. | |
| member | A row that joins a user to an organization with a role. | |
| role, rank | A role is a name such as `admin`. Its rank is its number in the rank table. | |
| invitation | A mailed, single-use offer to join an organization. | |
| hook | The app's code at a named point of a core flow. | |
| sweep | The scheduled delete of the rows that no flow can use. | |
| limiter | The counter of attempts per key and window. | |
| storage port | The six storage methods that core calls. | |
| adapter | An implementation of the storage port for one database. | |
| seam | A named module around a supplier library, so that a replacement plugs into the same calls. | |
| compatibility package | A package that runs code written for another auth library on authtempo. | |
| importer | The code that moves users from another provider into authtempo. | |
| legacy hash | A password hash in the format of another system. It changes to PBKDF2 at the first right sign-in. | |
| cutover | The moment that an app moves from its old auth system to authtempo. | |
| `baseURL` | The origin of the server that mounts `auth.handle`. | |
| `appURL` | The origin where the browser lands after a sign-in. | |
| trusted origin | An origin or an app scheme in `trustedOrigins`. | |

## Next

- [The configuration reference](/docs/reference/config/)
