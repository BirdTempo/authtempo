---
title: Routes
description: Every route that core serves under basePath, with what it needs, what it takes, what it answers, and its error codes.
type: reference
sources:
  - packages/core/README.md "Routes under"
  - packages/core/src/http/route-list.ts
  - packages/core/src/http/body-cap.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
  - docs/superpowers/plans/2026-10-14-11g-openapi.md
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md
  - packages/core/src/http/impersonation-rules.ts
  - docs/superpowers/plans/2026-10-14-12h-observability.md
  - packages/core/src/http/health.ts
  - docs/superpowers/plans/2026-10-14-12i-sign-in-additions.md
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 5"
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 3"
---

**For:** a developer who calls the routes of core, or checks what a route answers.

**What it does:** this page lists every route of core, one anchor for each. A path is relative to `basePath`, which is `/auth` by default. The same routes are in the OpenAPI document at [`/docs/reference/openapi.json`](/docs/reference/openapi.json).

## Before you start

- Read [Configuration](/docs/reference/config/) for the keys that turn each group of routes on.

## The rules of every route

- A route that a config key turns off answers 404 `not_found`.
- With a `baseURL` list, a request to an origin outside the list answers 421 `host_not_allowed` before any route. In each rule, `baseURL` is the entry of the request's origin.
- A POST with an `Origin` header that is not `baseURL` and not in `trustedOrigins` answers 403 `origin_not_trusted`. Two routes are exceptions: Apple's form post callback, and the token endpoint, which states its own rule.
- A failure answers `{ "error": "<code>" }` with the status of the code. `hook_refused` also carries `message`, as does the `invalid_body` of an SSO or SCIM manager write. `not_ready` also carries `reason`, and `sso_required` carries `detail`.
- A request body past the cap of its route answers 413 [`body_too_large`](/docs/reference/errors/#body_too_large), and no parse runs. The cap is 65536 bytes, except 262144 bytes for `POST /social/apple/callback`, and 8388608 bytes for `POST /sso/connections/create` and `POST /sso/connections/update`. A JSON body nested deeper than 16 or with more than 4096 items outside its strings answers 400 [`invalid_body`](/docs/reference/errors/#invalid_body), and no parse runs. The SCIM routes answer their own SCIM 413 past 1 MB.
- An unhandled error answers 500 [`internal`](/docs/reference/errors/#internal) and writes one log line.
- An `OPTIONS` preflight from a trusted origin answers 204 with the CORS headers. A preflight from another origin answers 403, except where a route states its own rule.
- Every answer to a trusted origin carries the CORS headers with credentials.
- The Errors cell of a route does not repeat `not_found`, `origin_not_trusted`, and `internal`, the codes of the router. A route also answers `not_found` for a record that it names and does not find.
- The Errors cell names `impersonation_session` on each route that an impersonation session cannot reach. The router answers it after the route match and before the handler.
- The Needs cell names each credential form that the route takes. "A session cookie, or a `ts_` bearer token" is a session in either form.

## Sessions

These routes exist in every deployment.

<h3 id="get-session"><code>GET /session</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ user, session }`; a sliding refresh renews the cookie. With `session.deferRefresh` on, the answer adds `needsRefresh`, and the route writes nothing and renews no cookie. `session.actorId` is the user id of the operator for an [impersonation](#impersonation) session, else null |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-session-refresh"><code>POST /session/refresh</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ user, session }`; when the refresh is due, the expiry moves and the cookie is renewed. It serves with `session.deferRefresh` on or off |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-sign-out"><code>POST /sign-out</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ ok: true }`, and the cookie is cleared. With `multiSession` on, every session of the bag cookie ends too, and the bag cookie is cleared: the sign-out ends every session of the browser |
| Errors | [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Account

These routes serve a settings page (plan 12a). They exist in every deployment unless a row names a feature. A fresh session is one that a sign-in or a re-authentication proved within `session.freshMinutes`.

<h3 id="post-reauth"><code>POST /reauth</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | JSON `{ password?, emailCode?, passkey?, code? }`. One first proof: `{ password, code? }`, `{ emailCode, code? }`, or `{ passkey }`. `code` is an authenticator code or a backup code, required after a password or an email code while the second factor is on. A passkey proves two factors and takes no `code`. With the email method only, `code` is a backup code: the email method as a re-authentication code is a later input. A user whose password row holds the legacy marker proves by an email code or a passkey. With `emailOtp` off or no `passkey` config, that proof answers `not_found` and the limit counts no try |
| Answer | `{ freshUntil }`, an ISO date. The session token and the expiry stay the same |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-reauth-email"><code>POST /reauth/email</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. `emailOtp` is on |
| Input | None. The route reads no body |
| Answer | `{ sent: true }`. A code goes to the user's address. Send it to `POST /reauth` as `emailCode` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-reauth-passkey-options"><code>POST /reauth/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The `passkey` config is set |
| Input | None. The route reads no body |
| Answer | The request options for `navigator.credentials.get`, with the user's passkeys. Send the assertion to `POST /reauth` as `passkey` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-sessions"><code>GET /sessions</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ sessions }`: the live sessions of the user, newest first, at most 100. Each has `id`, `createdAt`, `lastSeenAt`, `expiresAt`, `freshAt`, `ip`, `userAgent`, `activeOrganizationId`, `activeTeamId`, `current`, and `impersonation`. `impersonation` is true for a session that a platform operator opened, and the list names no operator. `lastSeenAt` moves only at the sliding refresh. `expiresAt` is the earlier of the row's expiry and the absolute cap |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-sessions-revoke"><code>POST /sessions/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ id }` |
| Answer | `{ ok: true, current }`. `current` is true for the caller's own id, which also clears the session cookie. A session JWT of that session lives to its `exp` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-sessions-revoke-others"><code>POST /sessions/revoke-others</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | None |
| Answer | `{ ended }`, the count of live sessions that the call ended. Every other session, the second-factor challenges, and the handoff codes go. A row past its expiry or the absolute cap goes too, with no count and no `revoked` event. The trusted devices, the API tokens, and the OAuth grants stay |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-user-update"><code>POST /user/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user is verified. No fresh rule |
| Input | JSON `{ name?, image? }`. `name`: 1 to 200 characters with no control character, no line or paragraph separator, no format character, and no lone surrogate, or null. A bidi control and a zero-width space are format characters. The zero-width non-joiner and joiner pass. `image`: an `https://` URL with a host, of at most 2048 characters, or null. The image has no `@` and no `%` in its authority. It holds no whitespace, no control or format character, no backslash, and none of `"<>{}\|^` or a backtick. Any other field is refused, the address too |
| Answer | `{ user }`: the `id`, `email`, `emailVerified`, `name`, and `image` of the stored row. Only the given fields change |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-user-change-email"><code>POST /user/change-email</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user is verified |
| Input | JSON `{ newEmail, method?, next? }`. `method` is `link` (the default) or `code`, which needs `emailOtp`. Any other field is refused |
| Answer | `{ sent: true }`. A proof goes to the new address. When any user holds that address, a note goes there in place of the proof, with the same answer. A new request spends the earlier proof |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-user-change-email-confirm"><code>GET /user/change-email/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ token }` |
| Answer | The confirm page, which posts the token. It reads nothing and spends nothing, so a mail scanner changes nothing. A malformed token answers 302 to `?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-user-change-email-confirm"><code>POST /user/change-email/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The token of the link is the credential. No session |
| Input | JSON or form `{ token }` |
| Answer | A form: 302 to `next`, or to `?auth_error=<code>` on a failure. JSON: `{ user }`. The address moves and is verified. Every other session and grant ends, and a notice goes to the old address |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`email_taken`](/docs/reference/errors/#email_taken), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-user-change-email-verify"><code>POST /user/change-email/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is of the same user, and `emailOtp` is on |
| Input | JSON `{ code }` |
| Answer | `{ user }`, the same move as the link confirm. The caller's session stays |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`email_taken`](/docs/reference/errors/#email_taken), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-identities"><code>GET /identities</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ identities: [{ id, provider, email?, linkedAt, canUnlink }], password, passkeys }`, the oldest link first. The `email` identity carries the address and `canUnlink: false`. The provider's user id is not in the answer |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-identities-unlink"><code>POST /identities/unlink</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ id }`. `id` is an id from the list. The `email` identity answers `invalid_body` |
| Answer | `{ ok: true }`. No session ends, and a notice goes to the address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`hook_refused`](/docs/reference/errors/#hook_refused), [`last_credential`](/docs/reference/errors/#last_credential), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-user-delete"><code>POST /user/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and `account.delete` is on (the default) |
| Input | JSON `{}`. Any field answers `invalid_body` |
| Answer | `{ ok: true }`. The session cookie is cleared. The user and every row that names it go. An organization where the user is the only member goes too, and a notice goes to the address. Its teams, invitations, tokens, roles, and SCIM rows go at the next sweep. With `account.deleteConfirm` on, the answer is `{ sent: true }`: a link goes to the address, and nothing is deleted. More than 50 solo organizations answer `delete_too_large`. On D1, a delete that cannot fit 50 queries answers it too. With 1 to 50 solo organizations, the user can own at most 2 organizations with another owner, and with none at most 4. A refusal changes nothing |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`hook_refused`](/docs/reference/errors/#hook_refused), [`sole_owner`](/docs/reference/errors/#sole_owner), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`delete_too_large`](/docs/reference/errors/#delete_too_large), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-user-delete-confirm"><code>GET /user/delete/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. `account.delete` is on (the default) |
| Input | Query `{ token }` |
| Answer | The confirm page of the mailed delete link, which posts the token. It reads nothing and spends nothing, so a mail scanner deletes nothing. A malformed token answers 302 to `?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-user-delete-confirm"><code>POST /user/delete/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is of the user who asked for the link. It need not be fresh |
| Input | JSON or form `{ token }` |
| Answer | A form: 302 to the app, or to `?auth_error=<code>` on a failure. JSON: `{ ok: true }`. Both clear the session cookie. The delete of `POST /user/delete` runs. On D1 the spend of the link costs 1 more query, and the confirm still fits the edge of `POST /user/delete`. With 1 to 50 solo organizations, the user can own at most 2 organizations with another owner, and with none at most 4 |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`sole_owner`](/docs/reference/errors/#sole_owner), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`delete_too_large`](/docs/reference/errors/#delete_too_large), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

## Magic link

These routes exist in every deployment.

<h3 id="post-magic-link-request"><code>POST /magic-link/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, next? }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="get-magic-link-verify"><code>GET /magic-link/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ token }` |
| Answer | 200, the confirm page; no side effect. A malformed token redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-magic-link-verify"><code>POST /magic-link/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON or form `{ token, trustDevice? }`. `trustDevice` is JSON only: the `td_` token of a trusted device. A browser sends the trust cookie |
| Answer | A form: 302 to `appURL` plus `next`, with the cookie. JSON: `{ user, session }` with the cookie. For a user with the second factor on, no cookie: a form gets a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge), and JSON gets `{ twoFactor: { challenge, expiresAt, methods } }` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

## Social sign-in

These routes exist for each configured provider. `:provider` is the name of the provider, such as `google`, `github`, or a list entry.

<h3 id="get-social-provider-start"><code>GET /social/:provider/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ next?, data? }`. `data` is the base64url of a UTF-8 JSON object for [the state payload](/docs/guides/social-state-data/). It needs `social.stateData` |
| Answer | 302 to the provider, with the binding cookie `__Secure-tempo_session_oauth`. A failure redirects to `/?auth_error=<code>` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed) |

<h3 id="post-social-provider-link"><code>POST /social/:provider/link</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user is verified. The callback needs the binding cookie and the session cookie of that session. Apple's form post needs no session cookie while it is `Lax` |
| Input | JSON or form `{ next?, data? }`. `data` is the state payload, as at the start |
| Answer | JSON: `{ url }` and the binding cookie; the client navigates to `url`. A form: 303 to the provider. The callback links the identity to the session's user and redirects to `next`. It sets no session cookie. A failure at the callback redirects to `/?auth_error=<code>` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed). The callback answers the codes of [`GET /social/:provider/callback`](#get-social-provider-callback), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-social-provider-callback"><code>GET /social/:provider/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The callback reads the binding cookie |
| Input | Query `{ code?, state?, error? }`. `code` and `state`, or `error`, come from the provider. The browser sends the trust cookie of a trusted device |
| Answer | 302 to `appURL` plus `next`, with the session cookie. For a user with the second factor on, a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge) with no session cookie. A failure redirects to `/?auth_error=<code>` |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`identity_taken`](/docs/reference/errors/#identity_taken), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-social-apple-callback"><code>POST /social/apple/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The callback reads the binding cookie. The Origin check is skipped |
| Input | JSON or form `{ code?, state?, error?, user?, id_token? }`. Apple sends a form with `code`, `state`, and `user?` |
| Answer | The same as the GET callback. A cross-site post carries no trust cookie, so a user with the second factor on goes to the challenge page, which offers the trusted device |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`identity_taken`](/docs/reference/errors/#identity_taken), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-social-provider-id-token-nonce"><code>POST /social/:provider/id-token/nonce</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The route exists for `google` and `apple`, while `social.idToken` is not `false` |
| Input | JSON `{}` |
| Answer | `{ nonce, providerNonce, expiresAt }`. The nonce is 32 random bytes as base64url, and it lives 5 minutes. `providerNonce` is its lowercase SHA-256 hex, and core stores only that hex. Give `providerNonce` to Google One Tap as `nonce`, and to Apple's sheet as its nonce. Keep `nonce` in the app and post it with the token. Never give `nonce` to the provider: a token that carries it is refused |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-social-provider-id-token"><code>POST /social/:provider/id-token</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The route exists for `google` and `apple`, while `social.idToken` is not `false`. The Origin check applies, so core takes no form post of One Tap's redirect mode |
| Input | JSON `{ idToken, nonce?, name?, next?, trustDevice? }`. `nonce` is the raw `nonce` of the nonce route, not `providerNonce`. It is needed while `social.idToken.requireNonce` is on, and for an Apple token with `nonce_supported` true. `name` is the name that Apple's native sheet gives the app; it fills a new Apple user only |
| Answer | `{ token, user, session, via? }` with the session cookie, or `{ twoFactor }` with no cookie for a user with the second factor on. The token's `nonce` claim must be the SHA-256 hex of the posted `nonce`. While `social.idToken.requireNonce` is on, a party that holds only the token sees only the hash, so it cannot post the nonce. With `requireNonce` false, a token posted with no nonce skips the hash check, except an Apple token with `nonce_supported` true. So a party that holds only such a token can sign in before the app. Only the one-use row of the token then stops a second use. Core checks the token before it spends the nonce, so a bad token cannot use the nonce up. The nonce is spent once. The token must verify against the provider's key set, with RS256 or ES256, the provider's issuer, one `aud` of `clientId` and `audiences`, an `exp` not past, an `iat` at most 60 seconds ahead, and a life of at most one day. Each token signs in once, on every instance. The account rules and the gate are those of the callback. A live anonymous session of the request is replaced |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

Owner check before the first release with this route. Core's tests use test keys, not real tokens. Run these checks on a real device:

1. Sign in once with Google One Tap. Give it `providerNonce`, and confirm that the token's `nonce` claim is that value.
2. Sign in once with the native Apple sheet. Give it `providerNonce`, and confirm that the token's `nonce` claim is that value.
3. On the Apple token, confirm that `exp` minus `iat` is 86400 seconds or less. Core refuses a token with a longer life.

## Passkeys

These routes exist when the config sets `passkey`.

<h3 id="post-passkey-register-options"><code>POST /passkey/register/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified. A user with no address passes when it is not anonymous: a phone or passkey sign-up proved its handle |
| Input | JSON `{ hints? }`. The body is optional. `hints` lists `security-key`, `client-device`, or `hybrid`, each once, and replaces `passkey.hints.register` for this ceremony |
| Answer | The creation options JSON for `navigator.credentials.create`, with `hints`, and with `extensions` when `passkey.extensions` asks for one. `user.name` is the first of the username, the address, the phone, the name, and the app name. `user.displayName` is the name, else the same value |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-passkey-register-verify"><code>POST /passkey/register/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified, or the user has no address and is not anonymous |
| Input | JSON `{ response, name? }`. A `name` that is blank after the trim, or that breaks the rule of [`POST /passkeys/rename`](#post-passkeys-rename), is stored as no name. The registration never refuses a credential for its name |
| Answer | `{ passkey }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-passkey-authenticate-options"><code>POST /passkey/authenticate/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ hints?, extensions? }`. The body is optional. `hints` lists `security-key`, `client-device`, or `hybrid`, each once, and replaces `passkey.hints.signIn` for this ceremony. `extensions` is `{ prf?: { first, second? }, largeBlob?: { read: true } }`: each PRF salt is the base64url of 32 bytes, and each extension needs its key of `passkey.extensions` on |
| Answer | The request options JSON for `navigator.credentials.get`, with `hints` when the ceremony has some, and `extensions` when the body has some |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-passkey-authenticate-verify"><code>POST /passkey/authenticate/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ response }`. Core drops `prf.results` and `largeBlob.blob` from `clientExtensionResults` before any read, store, or log |
| Answer | `{ user, session }` with the session cookie. A credential with no row answers `passkey_unknown`, so the app can call `PublicKeyCredential.signalUnknownCredential` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`passkey_unknown`](/docs/reference/errors/#passkey_unknown), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-passkey-sign-up-options"><code>POST /passkey/sign-up/options</code></h3>

These two routes exist when `passkey.signUp` is true or an object. They make a user with a passkey and no address.

A script with a software authenticator can make a user at each verify, with no attestation. The per-IP limit and the daily cap of the deployment bound it. The cap is `passkey.signUp.dailyCap`, default 1000. A script that spends the cap stops real sign-ups until the next day. So turn on the captcha flow `passkey-sign-up` on a public site.

| Field | Value |
| --- | --- |
| Needs | Nothing. With a live anonymous session, the verify replaces that user (see [Anonymous](#anonymous)) |
| Input | JSON `{ name, hints? }`. `name` is 1 to 80 characters, not blank, with no control, format, or bidi character. `hints` replaces `passkey.hints.register` for this ceremony |
| Answer | The creation options JSON for `navigator.credentials.create`. `user.id` is the base64url of the new user id, and `user.name` and `user.displayName` are the name. The options carry no address and no data of another user. No user exists until the verify |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |
| Captcha | With `captcha` and the flow `passkey-sign-up`: the header `x-captcha-response`, after the per-IP limit and before the daily cap. A failed captcha does not count against the cap |

<h3 id="post-passkey-sign-up-verify"><code>POST /passkey/sign-up/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The challenge of one options call makes one user |
| Input | JSON `{ response }`. Core drops `prf.results` and `largeBlob.blob` from `clientExtensionResults` before any read, store, or log |
| Answer | `{ user, session }` with the session cookie. The user has no address. `user.beforeCreate` and the session hooks see `via: "passkey"`. No second factor gates it: the passkey has user verification. A credential id that another user holds answers `passkey_failed` and makes nothing. Only `signUp: "open"` lets the user in |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="get-passkeys"><code>GET /passkeys</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, discoverable, prf, largeBlob, createdAt }], rpId, userHandle, userName, userDisplayName }`. `discoverable` (or null), `prf`, and `largeBlob` are advice from unsigned client outputs. `rpId` and `userHandle` (base64url of the user id bytes) are the inputs of `PublicKeyCredential.signalAllAcceptedCredentials`. `userName` and `userDisplayName` are the names of a new registration, the inputs of `PublicKeyCredential.signalCurrentUserDetails` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-passkeys-delete"><code>POST /passkeys/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`second_factor_last_method`](/docs/reference/errors/#second_factor_last_method), [`last_credential`](/docs/reference/errors/#last_credential), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-passkeys-rename"><code>POST /passkeys/rename</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. A fresh session is not needed: a name is no way in |
| Input | JSON `{ id, name }`. `name` has 1 to 64 characters, with no control or format character except the zero-width joiners |
| Answer | `{ passkey }`, in the shape of an item of `GET /passkeys`. No notice mail goes. Of two renames at once, the last one wins, and both answers show the stored name |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Passwords

These routes exist when the config sets `password`.

<h3 id="post-password-sign-up"><code>POST /password/sign-up</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, name?, username? }`. `username` needs the `username` config and `password.uniformSignUp: false`. With the uniform answer, a name at sign-up would tell a known address from a new one. So the sign-up refuses it with `invalid_body`, and the person sets the name with `POST /user/username` after the confirm. The sign-up checks the name before any read by address |
| Answer | 200 `{ sent: true }` with no cookie, for every address. The verify link opens the session. With a `waitUntil`, the user rows, `user.afterCreate`, and the mail run after the answer, for `password.verifyBy` `"link"` and `"code"` alike. A known and a new address do the same work before it. With `password.uniformSignUp: false`: a session with the cookie, or 409. With `uniformSignUp: false` and `password.requireVerified` on, or with `signUp: "invited"`: `{ user, verifyRequired: true }` with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`email_taken`](/docs/reference/errors/#email_taken), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`conflict`](/docs/reference/errors/#conflict), [`sso_required`](/docs/reference/errors/#sso_required), [`username_invalid`](/docs/reference/errors/#username_invalid), [`username_taken`](/docs/reference/errors/#username_taken) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="post-password-sign-in"><code>POST /password/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email?, username?, phone?, password, trustDevice?, next? }`. The body has exactly one of `email`, `username`, or `phone`. `username` needs the `username` config. `phone` needs the `phone` config. `phone` is E.164. A bad form of a username or a phone, or a phone outside `phone.regions`, answers `invalid_credentials` after the dummy hash |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie for a user with the second factor on |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-address, per-username, and per-phone limits |

<h3 id="get-password-verify"><code>GET /password/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ token }` |
| Answer | 200, the confirm page; no side effect |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-password-verify"><code>POST /password/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON or form `{ token }` |
| Answer | A form: 302 to `appURL` with the cookie. JSON: `{ verified: true }`, with the cookie when the address was unverified |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-password-verify-code"><code>POST /password/verify/code</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, code }` |
| Answer | `{ token, user, session }` with the cookie when the address was unverified; `{ verified: true }` with no cookie for a user already verified. The code is the one of the sign-up mail with `password.verifyBy: "code"`. A wrong, expired, or spent code and an unknown address answer `invalid_code` alike; the wrong code number `password.verifyCode.maxAttempts` (5 by default) spends the code |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-password-verify-resend"><code>POST /password/verify/resend</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address; the earlier link or code of the address stops. With `password.verifyBy: "code"`, the new code goes after the answer, and the address gets at most 10 code mails a day (`password-verify-code:email-day`). With the link, the new link goes after the answer while `password.uniformSignUp` is on (the default). With it off, the link goes before the answer, and the sign-up answer already tells a known address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-password-reset-request"><code>POST /password/reset/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, next? }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="get-password-reset"><code>GET /password/reset</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ token, error? }` |
| Answer | 200, the reset form; no side effect |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-password-reset"><code>POST /password/reset</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON or form `{ token, password, trustDevice? }`. `trustDevice` is JSON only |
| Answer | A form: 302 to `next` with the cookie, or back to the form. JSON: `{ token, user, session }` with the cookie. For a user with the second factor on, the reset still sets the password and ends every session, then answers no cookie: a form gets a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge), and JSON gets `{ twoFactor: { challenge, expiresAt, methods } }` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-password-change"><code>POST /password/change</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified. A first password, and a change while the second factor is on, need a fresh session |
| Input | JSON `{ currentPassword?, newPassword }` |
| Answer | `{ ok: true }`; every other session ends |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`sso_required`](/docs/reference/errors/#sso_required), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

## Second factor

These routes exist when the config sets `password` and `totp` is not `false`.

<h3 id="post-totp-setup"><code>POST /totp/setup</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ password }` |
| Answer | `{ secret, uri, backupCodes }`, each answered once. `backupCodes` is empty when another method is on, because the factor keeps its list |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-totp-enable"><code>POST /totp/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified |
| Input | JSON `{ code }` |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`, as `GET /totp`. As the first method, it ends every other session. `totp_not_enabled` means no setup, a setup older than 15 minutes, or a setup whose codes another method made stale: set up again |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-totp-disable"><code>POST /totp/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ code }`. `code` is a current code or a backup code |
| Answer | `{ ok: true }`, and the trust cookie is cleared. It turns the TOTP method off. With no method left, the factor is off |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-totp-backup-codes"><code>POST /totp/backup-codes</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user has a proved handle |
| Input | JSON `{ code }` |
| Answer | `{ backupCodes }`, a new list; the old codes stop |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-totp"><code>GET /totp</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`; never the secret. `enabled` is true when any method is on. `backupCodesVersion` is 1 for the codes of plan 9f, 2 for the codes of 23 characters, and `null` with the factor off |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-totp-devices-revoke"><code>POST /totp/devices/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ ok: true }`; every trusted device of the user goes |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-totp-verify"><code>POST /totp/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ challenge, code?, backupCode?, emailCode?, passkey?, trustDevice? }`. The body has one of `code`, `backupCode`, `emailCode`, or `passkey`. `passkey` is an assertion over the options of [`POST /second-factor/passkey/options`](/docs/reference/routes/#post-second-factor-passkey-options). |
| Answer | `{ token, user, session, next, backupCodesLeft, trustDevice }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="get-totp-challenge"><code>GET /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ challenge, method?, backup?, error? }` |
| Answer | 200, the form of the challenge's methods, with a trusted-device button when the browser sends a live trust cookie of the user. It reads rows and writes none. A malformed or dead challenge redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-totp-challenge"><code>POST /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON or form `{ challenge, code?, backupCode?, emailCode?, trustDevice?, action? }`. A form post sends `code`, `backupCode`, or `emailCode` with `trustDevice=1`; or `action=send-email`; or `action=trusted` |
| Answer | 302 to `next` with the cookies. Back to the form on a wrong code and after a send. `action=trusted` passes with the trust cookie alone |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`conflict`](/docs/reference/errors/#conflict), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`account_banned`](/docs/reference/errors/#account_banned), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-second-factor-passkey-enable"><code>POST /second-factor/passkey/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, the address is verified, and the `passkey` config is set |
| Input | JSON `{ password, response }`. `response` is an assertion over the options of [`POST /passkey/authenticate/options`](/docs/reference/routes/#post-passkey-authenticate-options) by a passkey of the user |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-second-factor-passkey-options"><code>POST /second-factor/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A live challenge that offers `passkey`, and the `passkey` config |
| Input | JSON `{ challenge }` |
| Answer | WebAuthn request options with the user's passkeys in `allowCredentials`, bound to this challenge |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-second-factor-disable"><code>POST /second-factor/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ method, password }`. `method` is `passkey` or `email` |
| Answer | `{ ok: true, methods }`, the methods left. With none left, the factor is off and the trust cookie is cleared. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-second-factor-email-enable"><code>POST /second-factor/email/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified |
| Input | JSON `{ password }` |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-second-factor-email-send"><code>POST /second-factor/email/send</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A live challenge of a password sign-in that offers `email` |
| Input | JSON `{ challenge }` |
| Answer | `{ sent: true }`. A 6-digit code goes to the user's address. It lives with the challenge, and a new send replaces it. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Email codes

These routes exist unless the config sets `emailOtp: false`. The two reset routes also need `password`.

<h3 id="post-otp-request"><code>POST /otp/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="post-otp-verify"><code>POST /otp/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, code, trustDevice? }` |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie for a user with the second factor on |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-otp-reset-request"><code>POST /otp/reset/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="post-otp-reset"><code>POST /otp/reset</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, code, password, trustDevice? }` |
| Answer | `{ token, user, session }` with the cookie. For a user with the second factor on, the reset sets the password and answers `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

## Phone

These routes exist when the config sets `phone`. A phone code is one factor over the phone network: a passkey is the stronger method. Core makes, keys, binds, and counts every code, and counts every SMS against `phone.dailyCap`. The SMS port only sends text.

The limits and the number checks run before the read of the number. So a 429 and a refusal tell nothing about an account.

`POST /phone/request` sends its code after the answer, and `POST /phone/add` sends its code or note after the answer. The daily cap, the code row, and the SMS run under the `waitUntil` that the host passes to `handle`. With no `waitUntil`, that work runs detached. So the answer time does not tell whether a number has an account: the supplier time is not in the answer. For the same reason, a cap refusal or an outage of the SMS port no longer shows in the answer. Core writes one `sms.not_sent` line with the reason, `capped` or `unavailable`. Watch that line, because the person who asked gets `{ sent: true }` and no code. A send after the answer has a time limit of 10 seconds. A hung SMS port then gives the reason `timeout`, and the flush of the events of the request still runs.

On Workers, pass `(p) => ctx.waitUntil(p)`, or mount a binding that passes it. Workers stops detached work at the answer, before its first I/O step. So on Workers with no `waitUntil`, or with one that throws, `handle` waits for the work before it answers, and the code goes out. Core then writes one `observe.wait_until_missing` line. On other runtimes the work runs detached.

Some residuals stay:

- `api.phone.request` and `api.phone.add` in process send before they answer. Their time can tell an account, and they answer 429 for the cap and 503 for an outage. An app route that calls them carries that residual.
- A region of one digit, such as `+1`, admits every country of that zone, with its numbers of a high cost: list narrow prefixes.
- Number recycling and SIM swap. A carrier gives a number to a new person, or an attacker moves the number to a new SIM. The new holder of the number then signs in to the account with the phone code. For an account with an address, core sends no mail at a phone sign-in. The session is fresh, so the routes with the fresh rule open to the new holder. Turn on the second factor and keep `totp.gate.phone` on to stop a holder of the number alone.
- A user with no address who moves the phone to a new number gets no notice on any channel. The old number gets no text.
- The work after the answer starts in the same task as the answer. Its first store calls run before the answer goes out. A known number answers about 0.3 to 0.8 ms later than an unknown one (measured in process, memory store, 2026-10-25 re-review). On a store with a sync driver, the cap count and the code row add to that time.
- On Workers with no `waitUntil`, the answer waits for the cap, the row, and the SMS of a known number. Its time then tells an account. Pass `waitUntil` to close it: each binding takes one, and most read it from the platform.

<h3 id="post-phone-request"><code>POST /phone/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ phone }` |
| Answer | `{ sent: true }` for a known and an unknown number. A known number gets a code, unless its account has an address in a domain with SSO `enforce` on. An unknown number gets a code only with `phone.signUp`. The code goes out after the answer, so a cap refusal or an outage gives an `sms.not_sent` line and no error. The SSO check runs after the answer too |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`phone_invalid`](/docs/reference/errors/#phone_invalid), [`phone_region`](/docs/reference/errors/#phone_region) |
| Captcha | With `captcha` and the flow `phone-request`: the header `x-captcha-response`, after the per-IP limit and before the per-number limits |

<h3 id="post-phone-verify"><code>POST /phone/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ phone, code, trustDevice? }` |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie for a user with the second factor on and `totp.gate.phone` on. With `phone.signUp`, a right code for a new number makes a user with no address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

<h3 id="post-phone-add"><code>POST /phone/add</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user has a proved handle |
| Input | JSON `{ phone }` |
| Answer | `{ sent: true }`. A free number gets a code. A number that another account holds gets a note with no code, and the same answer. Both write a code row: the row of a held number is a decoy that no code opens. The add counts on its own key per number, so it spends no sign-in count of the number. The code and the note go out after the answer, so a cap refusal or an outage gives an `sms.not_sent` line and no error |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`phone_invalid`](/docs/reference/errors/#phone_invalid), [`phone_region`](/docs/reference/errors/#phone_region), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-phone-add-verify"><code>POST /phone/add/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ code }` |
| Answer | `{ phone }`. The number replaces the earlier phone of the user. A notice goes to the user's address |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`phone_taken`](/docs/reference/errors/#phone_taken), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-phone-remove"><code>POST /phone/remove</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{}` |
| Answer | `{ ok: true }`. A notice goes to the user's address |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`last_credential`](/docs/reference/errors/#last_credential), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Anonymous

These routes exist when the config sets `anonymous`. An anonymous user has no address, no phone, no passkey, and no password: its session is its only key. A sign-in of another kind replaces the anonymous user.

Some routes answer 403 `anonymous_refused` to an anonymous session, before the handler. Each needs a way in, or would change the anonymous user in place. They are the re-authentication, the profile, the address, the username, and the account delete. They are also each way in, the second factor, and the organization create and the invitation accept. The API token create, the OAuth consent, and the device approve close the list. The list holds with `anonymous` off too, so an anonymous session of an earlier config stays out.

<h3 id="post-anonymous-sign-in"><code>POST /anonymous/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. A live anonymous session answers itself and makes nothing. A live session of another kind answers `conflict` |
| Input | JSON `{}` |
| Answer | `{ token, user, session }` with the cookie. The stored user has no address and `isAnonymous: true`, and the answer's `user` has `email: null`. No second factor gates it |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`conflict`](/docs/reference/errors/#conflict), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |
| Captcha | With `captcha` and the flow `anonymous-sign-in`: the header `x-captcha-response`, after the per-IP limit |

<h3 id="post-anonymous-delete"><code>POST /anonymous/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user is anonymous. The session need not be fresh: it is the only key of the user |
| Input | JSON `{}` |
| Answer | `{ ok: true }` with the cleared cookie. The user and its sessions go, with `user.beforeDelete` and `user.afterDelete` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Handoff

These routes exist when the config sets `handoff`.

<h3 id="get-handoff-start"><code>GET /handoff/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token |
| Input | Query `{ challenge, redirect }` |
| Answer | 200, the sign-in page, or 302 to the confirm page when the browser has a session |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-handoff-continue"><code>GET /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. The confirm page needs the session |
| Input | Query `{ h }` |
| Answer | 200, the confirm page, or the sign-in page without a session |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-handoff-continue"><code>POST /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. The confirm needs the session, and `Origin` equal to `baseURL` |
| Input | JSON or form `{ h }` |
| Answer | 302 to `<redirect>?code=` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-handoff-redeem"><code>POST /handoff/redeem</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ code, verifier }` |
| Answer | `{ token, user, session }` as a bearer answer, with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned) |

## Organizations

These routes exist when the config sets `organizations`. A write that runs an organization hook also answers the hook codes. The Errors row of each route names its codes.

<h3 id="post-organizations-create"><code>POST /organizations/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ slug, name, metadata? }` |
| Answer | `{ organization, member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`organization_limit`](/docs/reference/errors/#organization_limit), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-organizations"><code>GET /organizations</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ organizations: [{ organization, role }] }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-update"><code>POST /organizations/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin`, or `owner` for a slug |
| Input | JSON `{ organizationId, name?, slug?, metadata? }` |
| Answer | `{ organization }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-organizations-delete"><code>POST /organizations/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `owner` |
| Input | JSON `{ organizationId }` |
| Answer | `{ ok: true }`. On Postgres, a set of the active organization at the same moment makes a round of the delete start again. After 5 such rounds it answers `conflict`. The SCIM Groups of the organization go too. An organization with more than 500 SCIM Groups answers `delete_too_large`, and nothing changes |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`delete_too_large`](/docs/reference/errors/#delete_too_large) |

<h3 id="get-organizations-members"><code>GET /organizations/members</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `viewer` |
| Input | Query `{ organizationId }` |
| Answer | `{ members }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-members-add"><code>POST /organizations/members/add</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, userId, role }` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-members-role"><code>POST /organizations/members/role</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, userId, role }` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-members-remove"><code>POST /organizations/members/remove</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin`, or is the member. With `revokeTokens: true`, the user also holds `apiToken:revoke`, and the session is fresh |
| Input | JSON `{ organizationId, userId, revokeTokens? }`. `revokeTokens: true` deletes the organization tokens that the person made in this organization, in the same write. Without it, those tokens stay |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-invite"><code>POST /organizations/invite</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, email, role, teamIds? }`. `teamIds` needs `organizations.teams`: at most 20 distinct teams of the organization, else `invalid_body`. An invite with `teamIds` also needs `member:update`, the right of a team member add, else `forbidden_rank` |
| Answer | `{ invitation }`, with no token |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invitation_limit`](/docs/reference/errors/#invitation_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-organizations-invitations"><code>GET /organizations/invitations</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | Query `{ organizationId }` |
| Answer | `{ invitations }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-invitations-revoke"><code>POST /organizations/invitations/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, invitationId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-invitations-accept"><code>POST /organizations/invitations/accept</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is the invited address, and it is verified |
| Input | JSON `{ token }` |
| Answer | `{ organization, member }`. The accept adds the person to each team of the invitation that still exists. A full team answers `team_member_limit`, and the invitation stays pending |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`team_member_limit`](/docs/reference/errors/#team_member_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="post-organizations-invitations-decline"><code>POST /organizations/invitations/decline</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. The token of the invitation is the credential |
| Input | JSON `{ token }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-organizations-active"><code>POST /organizations/active</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user is a member of the organization |
| Input | JSON `{ organizationId }`. `organizationId` is a string or `null` |
| Answer | `{ user, session }` with `session.activeOrganizationId`. A change of the organization sets `session.activeTeamId` to `null` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-has-permission"><code>POST /organizations/has-permission</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401 |
| Input | JSON `{ organizationId, permissions }`. Another key answers `invalid_body` |
| Answer | `{ success }`: `true` when the session's role in the organization holds every action. A non-member gets `false` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="get-organizations-permissions"><code>GET /organizations/permissions</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401 |
| Input | Query `{ organizationId }` |
| Answer | `{ role, permissions }`: the session's role string and its actions. A non-member gets `role: null` and `{}` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-check-slug"><code>POST /organizations/check-slug</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified. An API token answers 401 |
| Input | JSON `{ slug }`. The slug holds 1 to 64 characters. Another key answers `invalid_body` |
| Answer | `{ slug, status }`: the slug after the NFKC fold to lower case, and `available`, `taken`, or `reserved`. A slug that does not fold to a valid slug answers `slug: null` and `invalid`. `available` is a hint, not a hold: the create can still answer `slug_taken` when another user takes the slug first |
| Limit | `slug-check:user:<userId>`, 60 per minute. The create and a rename to a new slug spend the same key |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-organizations-tokens"><code>POST /organizations/tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, the address is verified, and the user holds `apiToken:create`. A token answers 401 |
| Input | JSON `{ organizationId, name, expiresInDays?, permissions, metadata? }`. `permissions` is a subset of the user's set in the organization; `{}` grants nothing, and `null` answers `invalid_body`. Another key answers `invalid_body`, so a client sets no window and no quota |
| Answer | `{ token, apiToken }`; the clear `to_` token appears once. `apiToken` has `createdById` and `creatorIsMember` |
| Limit | `token-create:user:<userId>`, 20 per hour, the key of `POST /tokens`. An organization holds at most 50 live tokens |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`organization_token_limit`](/docs/reference/errors/#organization_token_limit), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-organizations-tokens"><code>GET /organizations/tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified, and the user holds `apiToken:read` |
| Input | Query `{ organizationId }` |
| Answer | `{ tokens }`, newest first. `creatorIsMember` is false after the creator left the organization or deleted the account; the token still acts |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank) |

<h3 id="post-organizations-tokens-update"><code>POST /organizations/tokens/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, the address is verified, and the user holds `apiToken:update` |
| Input | JSON `{ organizationId, id, name?, permissions?, expiresAt? }`. It narrows only, as `POST /tokens/update`. Another key answers `invalid_body` |
| Answer | The `apiToken` after the change |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-tokens-revoke"><code>POST /organizations/tokens/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified, and the user holds `apiToken:revoke`. The creator of a token has no right of their own |
| Input | JSON `{ organizationId, id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-organizations-tokens-current"><code>GET /organizations/tokens/current</code></h3>

| Field | Value |
| --- | --- |
| Needs | A `to_` bearer token. No other credential |
| Input | None |
| Answer | `{ organization, apiToken }`, with no user: the token acts for the organization. Each answer spends one call of the token's quota |
| Limit | `token-use:to:<id>`, the token's own window, when it has one |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`token_exhausted`](/docs/reference/errors/#token_exhausted), [`conflict`](/docs/reference/errors/#conflict) |

## Dynamic roles

These routes exist when the config sets `organizations.dynamicRoles`. An organization stores its own roles beside the roles of the config. A role check reads them at each request, so a change applies at the next request. While they are on, a grant refuses a role part that neither the config nor a stored role names. The add, the role change, and the invite answer `forbidden_rank`; the accept answers `invalid_token`.

<h3 id="get-organizations-roles"><code>GET /organizations/roles</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `ac:read` in the organization |
| Input | Query `{ organizationId }` |
| Answer | `{ roles }`: each stored role with `id`, `name`, `rank`, `permissions`, `createdAt`, and `updatedAt`, by name. A row with a bad shape is left out |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="get-organizations-roles-get"><code>GET /organizations/roles/get</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `ac:read` in the organization |
| Input | Query `{ organizationId, name }` |
| Answer | `{ role }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-roles-create"><code>POST /organizations/roles/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh. An API token answers 401. The user holds `ac:create` in the organization |
| Input | JSON `{ organizationId, name, rank?, permissions }`. `name` is one role name that the config does not hold. `rank` is from 1 to the user's rank and below the owner rank, default 1. `permissions` are known actions that the user holds. Another key answers `invalid_body` |
| Answer | `{ role }`. A member or a pending invitation that holds the name as a role part answers `role_in_use` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`role_taken`](/docs/reference/errors/#role_taken), [`role_in_use`](/docs/reference/errors/#role_in_use), [`role_limit`](/docs/reference/errors/#role_limit), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-roles-update"><code>POST /organizations/roles/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh. An API token answers 401. The user holds `ac:update` in the organization, and the role's rank and actions |
| Input | JSON `{ organizationId, name, rank?, permissions? }`. The rules of the create hold for `rank` and `permissions`. Another key answers `invalid_body` |
| Answer | `{ role }`. An update that a parallel update of the role overtakes answers `conflict` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`conflict`](/docs/reference/errors/#conflict), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-organizations-roles-delete"><code>POST /organizations/roles/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh. An API token answers 401. The user holds `ac:delete` in the organization, and the role's rank and actions |
| Input | JSON `{ organizationId, name }` |
| Answer | `{ ok: true }`. A member or a pending invitation that holds the role answers `role_in_use` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`role_in_use`](/docs/reference/errors/#role_in_use), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Teams

These routes exist when the config sets `organizations.teams`. A team is a named group of members of one organization. A team has no role: every right comes from the organization role. A member removal, a team delete, and an organization delete remove the team rows and fire no team hook.

<h3 id="get-organizations-teams"><code>GET /organizations/teams</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user is a member of the organization |
| Input | Query `{ organizationId }` |
| Answer | `{ teams }`: each team with `id`, `organizationId`, `name`, `createdAt`, and `updatedAt`, by name |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-teams-create"><code>POST /organizations/teams/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `team:create` in the organization |
| Input | JSON `{ organizationId, name }`. `name` follows the organization name rule. Names are not unique. Another key answers `invalid_body` |
| Answer | `{ team }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`team_limit`](/docs/reference/errors/#team_limit), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-teams-update"><code>POST /organizations/teams/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `team:update` in the organization of the team |
| Input | JSON `{ teamId, name }`. Another key answers `invalid_body` |
| Answer | `{ team }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-teams-delete"><code>POST /organizations/teams/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `team:delete` in the organization of the team |
| Input | JSON `{ teamId }` |
| Answer | `{ ok: true }`. The team rows go, each session that acts in the team loses its active team, and each pending invitation loses the team. With `organizations.teams.keepLastTeam`, the last team answers `last_team`. On Postgres, a set of the active team at the same moment makes a round of the delete start again. After 5 such rounds it answers `conflict` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_team`](/docs/reference/errors/#last_team), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="get-organizations-teams-members"><code>GET /organizations/teams/members</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `member:read` in the organization of the team |
| Input | Query `{ teamId }` |
| Answer | `{ members }`: each with `id`, `teamId`, `userId`, `email`, `name`, and `createdAt`, by address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-teams-members-add"><code>POST /organizations/teams/members/add</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The user holds `member:update` in the organization of the team. To add another person, the user ranks at least as high as that person and holds each of their rights |
| Input | JSON `{ teamId, userId }`. The person is a member of the organization, else `not_found` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`team_member_limit`](/docs/reference/errors/#team_member_limit), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="post-organizations-teams-members-remove"><code>POST /organizations/teams/members/remove</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401. The removal of another person needs `member:delete` in the organization of the team. It also needs a rank at least as high as that person's, and each of their rights. A member leaves a team with their own `userId` |
| Input | JSON `{ teamId, userId }` |
| Answer | `{ ok: true }`. A session of the person that acts in the team loses its active team |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-teams-active"><code>POST /organizations/teams/active</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The team is a team of the session's active organization, and the user is a member of the team |
| Input | JSON `{ teamId }`. `teamId` is a string or `null` |
| Answer | `{ user, session }` with `session.activeTeamId` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="get-organizations-teams-mine"><code>GET /organizations/teams/mine</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. An API token answers 401 |
| Input | None |
| Answer | `{ teams }`: the teams of the user in every organization, by name |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

## API tokens

These routes exist in every deployment.

<h3 id="post-tokens"><code>POST /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified. A token of another form answers 401 |
| Input | JSON `{ name, expiresInDays?, organizationId?, permissions?, metadata? }`. `permissions` narrows the token and needs `organizations`; a token bound to an organization holds a subset of the user's set there. `metadata` holds at most 4096 bytes as JSON. The route takes no window and no quota |
| Answer | `{ token, apiToken }`; the clear token appears once |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`token_limit`](/docs/reference/errors/#token_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-tokens"><code>GET /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | None |
| Answer | `{ tokens: [{ id, name, hint, expiresAt, lastUsedAt, organizationId, permissions, metadata, rateLimit, remaining, retired, createdAt }] }`, newest first |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-tokens-revoke"><code>POST /tokens/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-tokens-update"><code>POST /tokens/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified. A token of another form answers 401 |
| Input | JSON `{ id, name?, permissions?, expiresAt? }`. It narrows only. A new set is a subset of the old one, and a set over none narrows. A new `expiresAt` is earlier than the old one. Another key answers `invalid_body`, so a client sets no window and no quota |
| Answer | The `apiToken` after the change |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-tokens-current"><code>GET /tokens/current</code></h3>

| Field | Value |
| --- | --- |
| Needs | A `tk_` bearer token. No other credential |
| Input | None |
| Answer | `{ user, apiToken }`. Each answer spends one call of the token's quota. A key with a prefix of `tokens.movedPrefixes` resolves here too |
| Limit | `token-use:tk:<id>`, the token's own window, when it has one |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`token_exhausted`](/docs/reference/errors/#token_exhausted), [`token_retired`](/docs/reference/errors/#token_retired), [`conflict`](/docs/reference/errors/#conflict) |

## JWT minting

These routes exist unless the config sets `jwtMint: false`.

<h3 id="get-jwks"><code>GET /jwks</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | `{ keys }`: the signing key and at most 100 keys retired less than 24 hours ago; `cache-control: public, max-age=300` |
| Errors | None |

<h3 id="get-token"><code>GET /token</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. A `tk_` bearer or a JWT bearer answers 401 |
| Input | None |
| Answer | `{ token }`, a session JWT |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-token-live"><code>POST /token/live</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session JWT as the bearer. The JWT is of this instance. A session token, an API token, an access token, and a cookie answer 401 |
| Input | None |
| Answer | `{ live: true }` while the session of the JWT's `sid` claim exists and is not expired, else `{ live: false }`. A session from before the end of the user's last ban answers `{ live: false }`, also after the unban (`bannedFor`, as at every door). So does an impersonation session whose operator is banned, deleted, or without the platform role. It counts on `token-live:session:<sessionId>`, 120 per minute ([Limits](/docs/reference/limits/)) |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Operator

These routes exist when the config sets `operator.secretHash` or `operator.secrets`. `POST /operator/keys/rotate` also needs `jwtMint`. With `operator.users` and no secret, these four routes answer 404. Each answers counts and key names, never a sealed value, a hash, or a config value.

<h3 id="post-operator-keys-rotate"><code>POST /operator/keys/rotate</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret. `Authorization: Operator <secret>`, a secret whose SHA-256 is `operator.secretHash` or the hash of an entry of `operator.secrets`. The secret must be 32 to 512 visible ASCII characters, and any other secret answers 401 with no reason. The secret needs the scope `keys`, and a secret with no scope `keys` answers 403 `operator_required`. |
| Input | None |
| Answer | `{ kid }`, the id of the new signing key. The old key verifies for 24 hours and signs nothing |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-operator-secrets-status"><code>GET /operator/secrets/status</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret. `Authorization: Operator <secret>`, as `POST /operator/keys/rotate`. The secret needs the scope `secrets` |
| Input | None |
| Answer | `{ versions }`: for each version, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, `emailCodes`, `ssoClientSecrets`, and `stateData`, the answer of `api.secrets.status()`. It counts on `operator-secrets:ip:<ip>`, 120 per hour with rewrap and info, right or wrong secret ([Limits](/docs/reference/limits/)) |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-secrets-rewrap"><code>POST /operator/secrets/rewrap</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret. `Authorization: Operator <secret>`, as `POST /operator/keys/rotate`. The secret needs the scope `secrets` |
| Input | JSON `{ limit?, after?, callBudget? }`. `limit` is a whole number from 1 to 1000, default 100. `after` is the `next` of the last answer, so a pass reads each row once. `callBudget` is the storage calls of the call, 50 to 1000, default 50 for D1 Free. A call that the budget stops answers `more: true` and `next`. An empty body is `{}`. Another key, a limit of another form, or a cursor that is not `totp:<id>`, `jwk:<id>`, or `ssoConnection:<id>`, answers `invalid_body` |
| Answer | `{ resealed, failed, skipped, more, next }`, the answer of `api.secrets.rewrap({ limit, after })`: the rows this call moved to the current version, the rows that did not open or did not write, the live setups it left, whether a row under a configured old version remains, and the cursor. It counts on `operator-secrets:ip:<ip>` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-operator-info"><code>GET /operator/info</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret. `Authorization: Operator <secret>`, as `POST /operator/keys/rotate`. The route gives no value, so a secret with any scope opens it |
| Input | None |
| Answer | `{ core, schemaVersion, configKeys }`: the version of core, its schema version, and the sorted key paths of the config, for example `operator.secretHash`. Names only: no value, no hash, and no member of `storage`, `mail`, `limiter`, `clock`, `jwt`, `webauthn`, or `clientIp`. It counts on `operator-secrets:ip:<ip>` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## Impersonation

These routes exist when the config sets `operator.impersonation`, which needs `operator.users` and `organizations.platformRole`. A platform operator acts as a user for support. The session has a fixed expiry, a mark, and a notice to the user. A request with an operator secret answers 401: these routes take a session only.

<h3 id="post-operator-impersonate"><code>POST /operator/impersonate</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session passes the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON `{ userId, reason }`. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ expiresAt, auditId }`. The session cookie gets the token of the new session, and the cookie `<cookie name>_actor` gets the operator's own token. Both cookies get the Max-Age of the new session ([Cookies](/docs/reference/cookies/)). A bearer caller gets `{ token, expiresAt, auditId }` and no cookie. The new session ends at `operator.impersonation.ttlMinutes`, and no refresh moves it. It counts on `operator-impersonate:user:<userId>`, 20 per hour ([Limits](/docs/reference/limits/)). The user gets a notice mail unless `operator.impersonation.notice` or `account.notices` is false |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_refused`](/docs/reference/errors/#impersonation_refused), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-impersonate-stop"><code>POST /operator/impersonate/stop</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is an impersonation session, else the route answers 404 `not_found` |
| Input | JSON `{ reason? }`. An empty body is `{}`. Without `reason`, the audit row holds a fixed text. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ auditId, restored }`. The route ends the session and clears the actor cookie. While the operator's own session lives, the session cookie gets its token back and `restored` is true; else the route clears the session cookie. A bearer caller gets no cookie and `restored: false` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

## Operator user tools

These routes exist when the config sets `operator.users` (plan 12f). A secret call counts on `operator-users:ip:<ip>`, 600 per hour, right or wrong secret. A secret that matches also counts on `operator-users:secret:<name>`, 600 per hour from any IP. A platform operator counts on `operator:user:<userId>`, 600 per hour ([Limits](/docs/reference/limits/)). A request with an operator secret and a session answers 401. A user actor never acts on their own user or on another platform operator. Each write writes one audit row in its transaction, and its answer names the row. The operator user guard also refuses a session from before the last write of the user's platform role. So after a grant or a re-grant, the operator signs in again. Each write reads a body of the type `application/json` only. A body of another type, or with no type, answers `invalid_body`.

<h3 id="get-operator-users"><code>GET /operator/users</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | Query { after?, limit? }. `limit` is 1 to 100, default 50. `after` is the `next` of the last answer |
| Answer | `{ users, next }`: the users by `id` ascending. Each user has `id`, `email`, `emailVerified`, `name`, `createdAt`, `ban`, `platformOperator`, `secondFactor`, `sessions` (live, at most 100), and `identities` (provider names). No hash, token, or provider subject. `next` is null on the last page |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-operator-users-search"><code>GET /operator/users/search</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | Query { email?, emailPrefix?, id?, after?, limit? }. Exactly one of `email`, `emailPrefix`, and `id`. A prefix has 3 to 254 characters after the address rule, and matches with case and with no wildcard. A prefix search reads the whole user table |
| Answer | `{ users, next }`, as `GET /operator/users`. No match answers `{ users: [], next: null }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-operator-users-get"><code>GET /operator/users/get</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | Query { userId } |
| Answer | `{ user }`, one user as `GET /operator/users` gives it. A user id that names no user answers 404 `not_found` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-ban"><code>POST /operator/users/ban</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, reason, until? }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. `until` is a date and time with a zone, 1 minute to 3650 days from now; with no `until` the ban has no end |
| Answer | `{ auditId }`, and `familyEndFailed: true` when the end of the OAuth families failed after the commit. The ban ends every challenge, handoff code, and OAuth refresh token and code of the user, and the sessions that fit the call. The sweep ends the other sessions, and until then every door refuses them. The row that holds them for the sweep also refuses a session or a family that starts in the 5 seconds after the ban. That bound covers a server whose clock runs ahead. API tokens stay, and work again after an unban |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-unban"><code>POST /operator/users/unban</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, reason }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ auditId }`. The unban restores no session. An unban of a user with no ban also writes its row |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-platform-role"><code>POST /operator/users/platform-role</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, grant, reason }. `grant` true grants the platform role, and false revokes it. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ auditId }`, and `familyEndFailed: true` when the end of the OAuth families failed after the commit. A grant needs a verified address and no ban. A revoke ends the sessions of the user that fit the call, and keeps one owner of the platform organization. The sweep ends the other sessions, and a second revoke ends them too. Until then each operator check refuses them. The row that holds them for the sweep also refuses a session that starts in the 5 seconds after the revoke. That bound covers a server whose clock runs ahead |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`email_unverified`](/docs/reference/errors/#email_unverified), [`account_banned`](/docs/reference/errors/#account_banned), [`member_limit`](/docs/reference/errors/#member_limit), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-second-factor-disable"><code>POST /operator/users/second-factor/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, reason, proof }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. `proof` is `{ method, reference, checkedAt }`: `method` is `document`, `in_person`, `video`, `knowledge`, or `other`. `reference` is the case id in your own system, at most 200 characters, never the evidence. `checkedAt` is a date and time with a zone, at most 7 days old |
| Answer | `{ auditId }`. The whole second factor goes, and the user gets the mail `factor_disabled` unless `account.notices` is false |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-create-admin"><code>POST /operator/users/create-admin</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. Only a secret with the scope `users` passes; a session caller gets 403 `operator_required` |
| Input | JSON { email, name?, reason }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ userId, created, auditId }`. It creates the platform organization when absent, the user when no user holds the address (not verified, no password), and the member row. The new operator has no power before a proof of the mailbox and a second factor |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`account_banned`](/docs/reference/errors/#account_banned), [`member_limit`](/docs/reference/errors/#member_limit), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-create"><code>POST /operator/users/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session. Each call of an actor counts on `operator-create:actor:<kind>:<id>`, 200 per hour, before the body and the scope check |
| Input | JSON { email, phone?, emailVerified?, name?, image?, firstSignIn?, reason }. `email` is required and may be null; a null address needs `phone` in E.164 form under the `phone` config. `firstSignIn` is `invite` (the default with an address), `reset` (needs the `password` config), or `none` (the only value with no address). `emailVerified: true` needs an address. A `phone` with a non-null `email` answers `invalid_body` (ruling 12 of plan 12f2). An operator who chose the number could sign in by a phone code. A name and an image follow the rules of [`POST /user/update`](#post-user-update). `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. Any other key, such as `password` or `role`, answers `invalid_body` |
| Answer | `{ userId, mailed, auditId }`. `mailed` is `invite`, `reset`, or null: what went to the person. Null also comes when the mail fails. An address of a domain that enforces SSO gets null too, with no invitation row and no mail. The answer holds no token and no link. The create writes no credential, reads no `signUp` rule, and sends no SMS. The audit row holds flags only, never the address, the phone, or the name. A refusal writes nothing and mails no one |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`phone_invalid`](/docs/reference/errors/#phone_invalid), [`phone_region`](/docs/reference/errors/#phone_region), [`email_taken`](/docs/reference/errors/#email_taken), [`phone_taken`](/docs/reference/errors/#phone_taken), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-update"><code>POST /operator/users/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `users`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, name?, image?, reason }. At least one of `name` and `image`. Null clears a field. A name and an image follow the rules of [`POST /user/update`](#post-user-update). `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. Any other key, such as `password`, `email`, or `emailVerified`, answers `invalid_body` |
| Answer | `{ user, auditId }`: the user as `GET /operator/users` gives it. The audit row names the changed fields, never a value. The act sends no mail. A user id that names no user answers 404 `not_found` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-users-delete"><code>POST /operator/users/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `delete`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session. Each call of an actor counts on `operator-delete:actor:<kind>:<id>`, 100 per hour, before the body and the scope check |
| Input | JSON { userId, reason }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ organizations, auditId }`: the ids of the solo organizations that went with the account. The delete ends every session, and mails the notice `account_deleted` with no IP. The last owner of an organization with other members answers `sole_owner`. On D1, a delete that cannot fit 50 queries answers `delete_too_large`. A refusal changes nothing. A user id that names no user answers 404 `not_found` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`sole_owner`](/docs/reference/errors/#sole_owner), [`delete_too_large`](/docs/reference/errors/#delete_too_large), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-sessions-end-user"><code>POST /operator/sessions/end-user</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `sessions`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { userId, reason }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | `{ ended, more, auditId }`. It ends the sessions, challenges, handoff codes, and OAuth refresh tokens and codes of one user, one page per call. Call again while `more` is true |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`operator_self`](/docs/reference/errors/#operator_self), [`conflict`](/docs/reference/errors/#conflict), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-sessions-end-all"><code>POST /operator/sessions/end-all</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `sessions`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { reason, limit? }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D. `limit` is 1 to 1000 sessions, default 500 |
| Answer | `{ ended, more, auditId }`. It ends up to `limit` sessions of all users, and keeps the session of a platform operator who calls it. A call stops early to stay inside 50 storage calls. Call again while `more` is true |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-operator-sso-enforce-off"><code>POST /operator/sso/enforce-off</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `sso`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | JSON { domainId, reason }. `reason` is 1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D |
| Answer | The domain with `enforce: false`, and `auditId`. The audit row `sso_enforce_off` holds the reason. The route exists when the config sets `operator` and `sso` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`invalid_body`](/docs/reference/errors/#invalid_body), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-operator-audit"><code>GET /operator/audit</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret; or a session cookie, or a `ts_` bearer token. A secret needs the scope `audit`. A session needs the operator user guard: the platform role, a verified address, a second factor, and a fresh session |
| Input | Query { targetUserId?, after?, limit? }. `targetUserId` reads one user's rows. `limit` is 1 to 100, default 50. `after` is the `next` of the last answer |
| Answer | `{ rows, next }`: the audit rows by `id` ascending, oldest first. A row has `id`, `createdAt`, `updatedAt`, `actorKind`, `actorId`, `action`, `targetUserId`, `reason`, `data`, `ip`, and `userAgent`. `actorId` names a secret by its name, never by the secret. `next` is the last id of a full page, else null |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-user-invite-confirm"><code>GET /user/invite/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The route exists with `operator.users` |
| Input | Query `{ token }` |
| Answer | 200, the confirm page with a form that posts the token; no storage read, no limiter call, no side effect. The `ui_` token comes in the invitation mail of a user created with `firstSignIn: "invite"`. A malformed token redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-user-invite-confirm"><code>POST /user/invite/confirm</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The route exists with `operator.users`. Each POST counts on `user-invite-confirm:ip:<ip>`, 20 per 15 minutes, before the token check |
| Input | JSON or form `{ token, trustDevice? }`. `trustDevice` is JSON only: the `td_` token of a trusted device. A browser sends the trust cookie |
| Answer | The link is spent once, lives `operator.invite.ttlHours`, and holds the address of the create. It proves the address and opens a session with the via `invite`. A form: 302 to `appURL` with the cookie. JSON: `{ user, session }` with the cookie. For a user with the second factor on, no cookie: a form gets a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge), and JSON gets `{ twoFactor: { challenge, expiresAt, methods } }` (`totp.gate.invite`). A wrong, spent, or expired link, and a link of a user whose address changed, answer `invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned), [`sso_required`](/docs/reference/errors/#sso_required) |

## OAuth provider

These routes exist when the config sets `oauth`. They answer the codes of the OAuth table, except where a code of the core table is named.

<h3 id="post-oauth-register"><code>POST /oauth/register</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or the initial access token as the bearer. `oauth.registration.dynamic` is on, and it is off by default. While `oauth.registration.initialAccessTokenHash` is set, the route needs the token |
| Input | JSON `{ redirect_uris, client_name?, token_endpoint_auth_method?, grant_types?, response_types?, jwks?, jwks_uri?, post_logout_redirect_uris?, backchannel_logout_uri?, backchannel_logout_session_required?, subject_type?, id_token_signed_response_alg?, dpop_bound_access_tokens? }`. The client metadata of RFC 7591 and OIDC Registration. An omitted `token_endpoint_auth_method` is `none`, not the `client_secret_basic` of RFC 7591 |
| Answer | 201 `{ client_id, client_id_issued_at, client_name?, redirect_uris, token_endpoint_auth_method, grant_types, response_types, jwks?, jwks_uri?, post_logout_redirect_uris?, backchannel_logout_uri?, backchannel_logout_session_required?, subject_type, id_token_signed_response_alg, dpop_bound_access_tokens, client_secret?, client_secret_expires_at? }`. A secret client gets `client_secret` in this answer only |
| Errors | [`invalid_redirect_uri`](/docs/reference/errors/#oauth-invalid_redirect_uri), [`invalid_client_metadata`](/docs/reference/errors/#oauth-invalid_client_metadata), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`invalid_token`](/docs/reference/errors/#oauth-invalid_token) |

<h3 id="get-oauth-authorize"><code>GET /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. With no session, the route holds the request for a sign-in |
| Input | Query `{ response_type?, client_id?, redirect_uri?, code_challenge?, code_challenge_method?, scope?, resource?, state?, nonce?, prompt?, dpop_jkt?, max_age?, display?, ui_locales?, claims_locales?, login_hint?, acr_values?, id_token_hint?, claims?, request?, request_uri?, registration?, request_id? }`. The first form holds the OAuth 2.1 parameters with PKCE S256, `resource`, `scope`, `state`, `nonce`, and `prompt`. A confidential client may omit PKCE only when it asks `openid` with a `nonce` (RFC 9700 section 2.1.1). `dpop_jkt` is the thumbprint of a DPoP key, 43 base64url characters. The exchange of the code then needs a proof of that key (RFC 9449 section 10). `prompt=login`, `max_age=0`, and a sign-in older than `max_age` seconds hold the request for a new sign-in. The session of the request never goes on. `display`, `ui_locales`, `claims_locales`, `login_hint`, `acr_values`, `id_token_hint`, and `claims` are read once and ignored. `request`, `request_uri`, and `registration` go back to the client with their error (OIDC Core 3.1.2.6). An empty `max_age`, `dpop_jkt`, `request`, `request_uri`, or `registration` counts as omitted (RFC 6749 section 3.1). The second form is `request_id` alone |
| Answer | 302 to `/oauth/sign-in` or to `oauth.signInURL`; 200, the consent page; or 302 to the client with `code`, `state`, and `iss` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_response_type`](/docs/reference/errors/#oauth-unsupported_response_type), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`login_required`](/docs/reference/errors/#oauth-login_required), [`consent_required`](/docs/reference/errors/#oauth-consent_required), [`request_not_supported`](/docs/reference/errors/#oauth-request_not_supported), [`request_uri_not_supported`](/docs/reference/errors/#oauth-request_uri_not_supported), [`registration_not_supported`](/docs/reference/errors/#oauth-registration_not_supported), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-oauth-authorize"><code>POST /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is of the user that the held request names. For `prompt=login` or `max_age`, the session signed in at or after the request. `Origin` equals `baseURL` |
| Input | Form `{ request_id, decision }`. `decision` is `allow` or `deny` |
| Answer | 302 to the client with `code`, or with `error=access_denied`. 302 to the sign-in step for an older session of the same user, with nothing spent |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`unsupported_response_type`](/docs/reference/errors/#oauth-unsupported_response_type), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-oauth-sign-in"><code>GET /oauth/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ next }`. `next` is `<basePath>/oauth/authorize?…`, or the device page: `<basePath>/oauth/device`, alone or with `?user_code=XXXX-XXXX` |
| Answer | 200, the sign-in page, which lands back on `next`; another `next` redirects to `/?auth_error=invalid_request` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-oauth-token"><code>POST /oauth/token</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or the client id and secret as HTTP Basic. A public client sends `client_id` and no credential. A client with a secret sends it as HTTP Basic or as `client_secret` in the form, one method per request (RFC 6749 section 2.3.1). An empty `client_secret` counts as omitted. A `private_key_jwt` client sends `client_assertion_type` and `client_assertion`, a JWT signed by its key (RFC 7523). A failed assertion is a 400 `invalid_client`. After an `Authorization` header, `invalid_client` is a 401 with `WWW-Authenticate: Basic` and the issuer as the realm. With no header it is a 400 with no challenge. A browser on a foreign origin needs that origin in a redirect URI of the public client that the form names. Its answer then carries `access-control-allow-origin` and no credentials. An origin of `trustedOrigins` gets that header with credentials. `POST /oauth/revoke` still answers 403 to a cross-site form post. A preflight from that origin names the client in `?client_id=` |
| Input | Form `{ grant_type, client_id?, client_secret?, client_assertion_type?, client_assertion?, code?, code_verifier?, redirect_uri?, resource?, refresh_token?, scope?, device_code? }`. `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `resource?`; or `grant_type=refresh_token` with `refresh_token`, `client_id`, `scope?`, `resource?`. A confidential client with the grant sends `grant_type=client_credentials` with `resource` and `scope?`. With `oauth.device` on, a device polls with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, and the client auth of the device request (RFC 8628 section 3.4). A Basic client may omit `client_id`. A code with no challenge takes no `code_verifier`. A `DPoP` header holds a proof of RFC 9449 for this URL and POST. Core checks it after the client auth and spends its `jti` before the grant. A client of `dpop_bound_access_tokens` must send one on every grant |
| Answer | `{ access_token, token_type, expires_in, scope, refresh_token?, id_token? }`. `token_type` is `"DPoP"` after a proof: the access token then holds `cnf.jkt`, the thumbprint of the key. A public client's refresh token is bound to the key too, and each refresh needs a proof of it. A confidential client's refresh token stays unbound (RFC 9449 section 5). With no proof, `token_type` is `"Bearer"`. The `client_credentials` grant answers no `refresh_token` and no `id_token`. The device grant answers as the code exchange, with an `id_token` for `openid`, once. A poll before the approval answers `authorization_pending`. A poll within `interval` seconds of the last answers `slow_down`, and the interval grows by 5 seconds. A denied code answers `access_denied`, and an expired one `expired_token`. A spent code answers `invalid_grant` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_grant`](/docs/reference/errors/#oauth-invalid_grant), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_grant_type`](/docs/reference/errors/#oauth-unsupported_grant_type), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`invalid_dpop_proof`](/docs/reference/errors/#oauth-invalid_dpop_proof), [`authorization_pending`](/docs/reference/errors/#oauth-authorization_pending), [`slow_down`](/docs/reference/errors/#oauth-slow_down), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`expired_token`](/docs/reference/errors/#oauth-expired_token), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-revoke"><code>POST /oauth/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or the client id and secret as HTTP Basic. A request that names a client takes the client auth of `POST /oauth/token`. A refresh token of a confidential client needs that auth. After an `Authorization` header, `invalid_client` is a 401 with `WWW-Authenticate: Basic` and the issuer as the realm. With no header it is a 400 with no challenge |
| Input | Form `{ token, client_id?, client_secret?, client_assertion_type?, client_assertion? }`. RFC 7009 |
| Answer | 200 `{}` for any token; a refresh token's family goes |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-introspect"><code>POST /oauth/introspect</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or the client id and secret as HTTP Basic. The caller takes the client auth of `POST /oauth/token`. It is a confidential client with `introspect: true` of `api.oauth.clients`. Any other caller gets `invalid_client`. After an `Authorization` header, `invalid_client` is a 401 with `WWW-Authenticate: Basic` and the issuer as the realm. With no header it is a 400 with no challenge |
| Input | Form `{ token, token_type_hint?, client_id?, client_secret?, client_assertion_type?, client_assertion? }`. RFC 7662. The hint orders the lookups only |
| Answer | `{ active: true, scope, client_id, sub, aud, iss, exp, iat, jti, token_type, cnf? }` for a live access token, and for a live refresh token of the caller. A DPoP-bound access token answers `token_type: "DPoP"` and `cnf: { jkt }`; the resource server checks the proof itself (RFC 9449 section 6.2). `{ active: false }` alone for every other token. An access token of a resource outside the caller's [`oauth.introspection`](/docs/reference/config/#oauth-provider) entry is inactive too. A refresh token answers its own client with no map entry. A revoke or a delete ends any token here at once. A scope that the config drops ends an access token at once. A refresh token then shows the scopes that the config still serves, and it is inactive when only `offline_access` is left |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-device-authorization"><code>POST /oauth/device_authorization</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or the client id and secret as HTTP Basic. `oauth.device` is on. The caller takes the client auth of `POST /oauth/token`, and the client holds the device grant. A pairwise client is refused. After an `Authorization` header, `invalid_client` is a 401 with `WWW-Authenticate: Basic` and the issuer as the realm. With no header it is a 400 with no challenge |
| Input | Form `{ client_id?, client_secret?, client_assertion_type?, client_assertion?, scope?, resource? }`. RFC 8628 section 3.1. `scope` and `resource` are checked as at `GET /oauth/authorize`. A `DPoP` header with a proof for this URL binds the device code to its key: each poll then needs a proof of that key |
| Answer | `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`. RFC 8628 section 3.2. `user_code` is `XXXX-XXXX` of the letters `BCDFGHJKLMNPQRSTVWXZ`. `verification_uri` is `<issuer>/oauth/device` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_dpop_proof`](/docs/reference/errors/#oauth-invalid_dpop_proof), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-device"><code>GET /oauth/device</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. `oauth.device` is on. With no session, the route sends the browser to the sign-in step |
| Input | Query `{ user_code? }`. A code of the `XXXX-XXXX` form fills the field. The person still submits it (RFC 8628 section 3.3.1) |
| Answer | 200, the device page; or 302 to `/oauth/sign-in` or to `oauth.signInURL`. After `oauth.signInURL`, the person types the code again: core never stores a user code in clear. A request with no session counts on `oauth-authorize:ip`, as the authorize step does |
| Errors | [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-oauth-device"><code>POST /oauth/device</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. `oauth.device` is on. `Origin` equals `baseURL` |
| Input | Form `{ user_code, decision? }`. Without `decision` the page shows the client of the code, its scopes, and the line "Approve only a device that is in front of you." `decision` is `allow` or `deny` |
| Answer | 200, the device page: the form again with its error, the consent, or the end of the decision. Each post counts 5 per session and 20 per IP per 15 minutes. A found code counts 10 per 15 minutes |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

<h3 id="get-oauth-userinfo"><code>GET /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token of the OAuth provider as the bearer; or a DPoP-bound access token with its proof. The token has the scope `openid`. A bound token goes as `Authorization: DPoP <token>`, with a proof of its key for this URL and method in the `DPoP` header. A bound token as a bearer answers 401 (RFC 9449 section 7.2). `WWW-Authenticate` names both schemes, and the scheme of the request carries the error. A bad proof answers 401 `invalid_dpop_proof` in the body and in the challenge |
| Input | None |
| Answer | `{ sub, email?, email_verified?, name?, picture? }` by scope |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope), [`invalid_dpop_proof`](/docs/reference/errors/#oauth-invalid_dpop_proof) |

<h3 id="post-oauth-userinfo"><code>POST /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token of the OAuth provider as the bearer; or a DPoP-bound access token with its proof. The token has the scope `openid`. The rules are those of the GET, and the proof names POST |
| Input | None |
| Answer | The same as the GET |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope), [`invalid_dpop_proof`](/docs/reference/errors/#oauth-invalid_dpop_proof) |

<h3 id="get-oauth-grants"><code>GET /oauth/grants</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. A token of another form answers 401 |
| Input | None |
| Answer | `{ grants }`: `clientId`, `clientName`, `scopes`, `createdAt`, `refreshTokens` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-oauth-grants-revoke"><code>POST /oauth/grants/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. A token of another form answers 401 |
| Input | JSON `{ clientId }` |
| Answer | `{ ok: true }`, also when nothing existed |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-oauth-end-session"><code>GET /oauth/end-session</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. With a session and no valid hint of it, the page asks before the session ends (`OIDC RP-Initiated Logout 1.0` section 2) |
| Input | Query `{ id_token_hint?, client_id?, post_logout_redirect_uri?, state?, logout_hint?, ui_locales? }`. `logout_hint` and `ui_locales` are read and ignored. A hint is an ID token of this issuer. Its signature, `iss`, and `aud` are checked, and an expired hint still counts. A `client_id` must equal the hint's `aud` |
| Answer | A valid hint of the session that the request carries ends that session at once, and `session.afterEnd` fires with `oidc_logout`. Any other request with a session answers the confirmation page, and a GET ends nothing. With no session nothing ends. A frame carries no `SameSite=Lax` cookie. So a GET with `Sec-Fetch-Dest` other than `document` and no session gets a page with a top-level link to the same GET, and no redirect. The answer is a 302 to the `post_logout_redirect_uri` with `state` only for a valid hint and an exact entry of the client's `post_logout_redirect_uris`. Else it is the signed-out page |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-oauth-end-session"><code>POST /oauth/end-session</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. With a session and no valid hint of it, the page asks before the session ends (`OIDC RP-Initiated Logout 1.0` section 2). The relying party's page may post the form from its own origin |
| Input | Form `{ id_token_hint?, logout_hint?, client_id?, post_logout_redirect_uri?, state?, ui_locales?, confirm? }`. The fields of the GET, and `confirm=yes` from the confirmation page. The yes counts only with `Origin` equal to `baseURL` |
| Answer | A POST that carries no session answers 303 to the GET of the same fields, without `confirm`. A browser sends no `SameSite=Lax` cookie on a cross-site POST, and the top-level GET carries it. So the relying party's form post becomes a GET, and only the GET ends the session. A POST with a session follows the GET rules. The yes ends the session. Each redirect of a POST is a 303 |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-well-known-oauth-authorization-server"><code>GET /.well-known/oauth-authorization-server</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | The metadata of RFC 8414; `cache-control: public, max-age=300` |
| Errors | None |

<h3 id="get-well-known-openid-configuration"><code>GET /.well-known/openid-configuration</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | The same document, for OpenID Connect Discovery |
| Errors | None |

## Enterprise SSO

These routes exist when the config sets `sso` (plan 12d). An organization proves an email domain by a TXT record. Every resolver of `sso.dns` must give the value. An organization adds an OIDC or a SAML connection to its sign-in provider. Each call counts on `sso-manage:user:<userId>`, 30 per 15 minutes, before the guard. Each write writes one audit row.

The manager guard runs these steps in order. An impersonation session answers `forbidden_rank`, and the router refuses each write to it with `impersonation_session`. A platform operator who passes the operator user guard manages every organization. The operator user guard needs the platform role, a verified address, a second factor, and a fresh session. An operator who fails it and owns no organization of the call gets `operator_required`. Else the user is an owner of the organization: a member whose role holds a static role of the owner rank, else `forbidden_rank`. The owner needs a second factor (`second_factor_required`) and a fresh session (`session_not_fresh`).

<h3 id="get-sso-domains"><code>GET /sso/domains</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | Query `{ organizationId }` |
| Answer | `{ domains }`: each domain with `id`, `organizationId`, `domain`, `record`, `verified`, `verifiedAt`, `checkedAt`, `connectionId`, `enforce`, `includeSubdomains`, and `expiresAt`, oldest first |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh) |

<h3 id="post-sso-domains-add"><code>POST /sso/domains/add</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ organizationId, domain }`. The domain is a host name of two labels or more, with no IP literal and no trailing dot. Its proof name `_authtempo-challenge.<domain>` has at most 253 characters |
| Answer | `{ domain }`. A pending domain holds `record`, the TXT record to publish, and lives 7 days. A second add of a pending domain gives a new value. A verified domain answers as it is |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`domain_limit`](/docs/reference/errors/#domain_limit), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-sso-domains-verify"><code>POST /sso/domains/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id }`. It counts on `sso-domain-verify:org:<organizationId>`, 10 per hour, before any resolver |
| Answer | `{ domain }` with `verified: true`. A domain that another organization holds answers `domain_taken` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`token_expired`](/docs/reference/errors/#token_expired), [`domain_unverified`](/docs/reference/errors/#domain_unverified), [`domain_taken`](/docs/reference/errors/#domain_taken), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-sso-domains-update"><code>POST /sso/domains/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id, connectionId?, enforce?, includeSubdomains? }`. `connectionId` names a connection of the same organization, else `not_found`, or null for no route. `enforce: true` needs a verified domain routed to an enabled connection, else `invalid_body` with a message |
| Answer | `{ domain }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-sso-domains-delete"><code>POST /sso/domains/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }`. The row and its claim go |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="get-sso-connections"><code>GET /sso/connections</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | Query `{ organizationId }` |
| Answer | `{ connections }`, oldest first. Each connection holds `id`, `organizationId`, `kind`, `label`, `enabled`, `jit`, `defaultRole`, `mfa`, `scimRoles`, `createdAt`, and `updatedAt`. An OIDC connection holds `oidc`: `issuer`, `clientId`, `scope`, `endpoints`, and `tokenEndpointAuthMethod`. A SAML connection holds `saml`: `idpEntityId`, `ssoUrl`, the `notAfter` of each certificate, `subjectAttribute`, `attributes`, `spEntityId`, and `acsUrl`. No answer holds the client secret or its sealed value |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh) |

<h3 id="post-sso-connections-create"><code>POST /sso/connections/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ organizationId, kind, label, enabled?, jit?, defaultRole?, mfa?, scimRoles?, issuer?, clientId?, clientSecret?, scope?, endpoints?, tokenEndpointAuthMethod?, idpMetadata?, idpEntityId?, ssoUrl?, certificates?, subjectAttribute?, attributes? }`. An OIDC connection (`sso.oidc`) needs `issuer`, `clientId`, and `clientSecret`. A SAML connection (`sso.saml`) needs `idpEntityId`, `ssoUrl`, and `certificates`. A field of the other kind answers `invalid_body`. A kind that the config does not turn on answers `not_found`. Each rule failure answers `invalid_body` with a message that names the field. The rules: `label` has 1 to 80 characters. `defaultRole` (default `member`) and each value of `scimRoles` name a role that the organization has, below the owner rank and never the platform role. The issuer and each endpoint are https URLs of a public host: no IP literal, no local name, and not the host of `baseURL`. `scope` holds `openid`. `tokenEndpointAuthMethod` is `client_secret_post` (the default: the secret in the body of the token request) or `client_secret_basic` (the id and the secret in an HTTP Basic header, each form-encoded first, RFC 6749 section 2.3.1). `certificates` holds 1 or 2 PEM certificates. `idpMetadata`, the metadata XML of the provider of at most 100 KB, takes the place of `idpEntityId`, `ssoUrl`, and `certificates`. Core parses it once and never fetches a metadata URL |
| Answer | `{ connection }`. Core seals the client secret under the current app secret, bound to the connection id. The organization holds at most `sso.limits.connectionsPerOrganization` connections |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`connection_limit`](/docs/reference/errors/#connection_limit), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-sso-connections-update"><code>POST /sso/connections/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id, organizationId?, kind?, label?, enabled?, jit?, defaultRole?, mfa?, scimRoles?, issuer?, clientId?, clientSecret?, scope?, endpoints?, tokenEndpointAuthMethod?, idpMetadata?, idpEntityId?, ssoUrl?, certificates?, subjectAttribute?, attributes? }`. Each field of the create for the kind of the connection takes its rule. `kind` and `organizationId` never change. A new `clientSecret` is sealed again under the current app secret. `enabled: false` answers `invalid_body` while an enforced domain routes to the connection |
| Answer | `{ connection }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-sso-connections-delete"><code>POST /sso/connections/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard above must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }`. Each domain routed to the connection loses its route and its `enforce` flag in the same transaction |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

The sign-in routes of a connection take no session. `:connectionId` is the id of the connection: one segment of `[A-Za-z0-9._:-]`, 1 to 128 characters. An OIDC connection signs in through the start and the callback. A SAML connection signs in through the start and the ACS.

<h3 id="post-sso-discover"><code>POST /sso/discover</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. It counts on `sso-discover:ip:<ip>`, 30 per 15 minutes |
| Input | JSON or form `{ email, next? }` |
| Answer | JSON: `{ sso: true, connectionId, start }` when a verified domain claims the address, the most specific first, and routes it to an enabled connection. `start` is `<baseURL><basePath>/sso/<connectionId>/start`, an absolute URL, with `next` as its query when the body has it. Else `{ sso: false }`. The connection may be an OIDC or a SAML connection, when `sso.oidc` or `sso.saml` turns its kind on. The answer reads no user, so it tells nothing about a person. A form: a page of this origin with a link and a meta refresh to `start`, with `next` as its query. The page has no script. Or a 302 to `/?auth_error=<code>` of `appURL`. Chromium applies `form-action` to each redirect after a form post, so a redirect to `start` would stop at the step to the provider |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`sso_not_configured`](/docs/reference/errors/#sso_not_configured) |

<h3 id="get-sso-connectionid-start"><code>GET /sso/:connectionId/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. It counts on `sso-start:ip:<ip>`, 30 per 15 minutes |
| Input | Query `{ next? }` |
| Answer | 302 to the provider of the connection, with the binding cookie `__Secure-tempo_session_oauth` on the path `<basePath>/sso`. For SAML, the 302 goes to the `ssoUrl` with `SAMLRequest` and `RelayState`, by the HTTP-Redirect binding. For OIDC, the redirect URI is `<baseURL><basePath>/sso/<connectionId>/callback`. A connection with no `endpoints` reads the discovery document of its issuer, kept one hour per isolate. Each discovered endpoint must be on a public host. A failure redirects to `/?auth_error=<code>` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`sso_not_configured`](/docs/reference/errors/#sso_not_configured), [`sso_failed`](/docs/reference/errors/#sso_failed) |

<h3 id="get-sso-connectionid-callback"><code>GET /sso/:connectionId/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The callback reads the binding cookie |
| Input | Query `{ code?, state?, error? }`. They come from the provider of the connection |
| Answer | The state must name this connection, and the binding cookie must match. Core exchanges the code, then checks the ID token with the issuer, the audience, and the nonce. It reads `sub`, `email`, `name`, `picture`, `amr`, and `acr`, and never `email_verified`. Then the address must be in a verified domain of the connection's organization. A known identity signs in its user, a user at the address gets the identity, and with `jit` a new user is created. The person gets a member row with the connection's `defaultRole`. A user with the second factor on gets the challenge page, unless the provider asserts a value of the connection's `mfa` list. Then a 302 to `next` with the session cookie. A failure redirects to `/?auth_error=<code>` |
| Errors | [`sso_failed`](/docs/reference/errors/#sso_failed), [`sso_not_configured`](/docs/reference/errors/#sso_not_configured), [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`email_required`](/docs/reference/errors/#email_required), [`sso_domain_mismatch`](/docs/reference/errors/#sso_domain_mismatch), [`sso_not_provisioned`](/docs/reference/errors/#sso_not_provisioned), [`account_disabled`](/docs/reference/errors/#account_disabled), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`member_limit`](/docs/reference/errors/#member_limit), [`role_not_found`](/docs/reference/errors/#role_not_found), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned) |

<h3 id="post-sso-connectionid-acs"><code>POST /sso/:connectionId/acs</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. It counts on `sso-acs:ip:<ip>`, 60 per 15 minutes. The provider posts the form cross-site, so the Origin and Fetch Metadata rules skip this route. The request row and the binding cookie bind the post to the browser of the start |
| Input | Form `{ SAMLResponse, RelayState }`. Each key comes once, and the form holds at most 1 081 519 bytes. `SAMLResponse` is the base64 of the Response, by the HTTP-POST binding |
| Answer | The `RelayState` names the request row of a start of this connection, and the binding cookie must match. The Response then passes the checks in order. First come the parse, the wrapping guard, and the signature of the Assertion. The signature of the Response follows when it has one. Then come the status, the `Destination`, the issuer, and the conditions with the clock skew. Last come the audience, the bearer confirmation with `InResponseTo`, the `AuthnStatement`, the subject, and the address. The request row is spent once, and the Assertion ID is kept until its `NotOnOrAfter`, so a replay fails. Then the resolution of the OIDC callback runs. A `SessionNotOnOrAfter` caps the session, also through each sliding refresh. A failure redirects to `/?auth_error=<code>` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`sso_failed`](/docs/reference/errors/#sso_failed), [`sso_not_configured`](/docs/reference/errors/#sso_not_configured), [`email_required`](/docs/reference/errors/#email_required), [`sso_domain_mismatch`](/docs/reference/errors/#sso_domain_mismatch), [`sso_not_provisioned`](/docs/reference/errors/#sso_not_provisioned), [`account_disabled`](/docs/reference/errors/#account_disabled), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`member_limit`](/docs/reference/errors/#member_limit), [`role_not_found`](/docs/reference/errors/#role_not_found), [`conflict`](/docs/reference/errors/#conflict), [`account_banned`](/docs/reference/errors/#account_banned) |

<h3 id="get-sso-connectionid-metadata"><code>GET /sso/:connectionId/metadata</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | `application/samlmetadata+xml`: one `EntityDescriptor` whose `entityID` is this URL, with one `SPSSODescriptor` (`AuthnRequestsSigned="false"`, `WantAssertionsSigned="true"`) and one HTTP-POST `AssertionConsumerService` at the ACS URL. It is not signed. An id that names no SAML connection answers 404 |
| Errors | [`sso_not_configured`](/docs/reference/errors/#sso_not_configured) |

## SCIM

These routes exist when the config sets `scim` (plan 12d). A directory, such as Entra ID or Okta, provisions the staff of an organization with a SCIM token. A token holds `sk_` and 43 characters. Core stores its SHA-256 only, so the answer of the create is the one time the token leaves core.

The three token routes run the steps of the SSO manager routes: a session, the count on `sso-manage:user:<userId>`, then the manager guard of [Enterprise SSO](#enterprise-sso). An impersonation session gets `impersonation_session` from the router at the create and the revoke, and `forbidden_rank` from the guard at the list. Each write writes one audit row, and no row holds the token or its hash.

<h3 id="get-scim-tokens"><code>GET /scim/tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard of [Enterprise SSO](#enterprise-sso) must pass: an owner of the organization, or a platform operator |
| Input | Query `{ organizationId }` |
| Answer | `{ tokens }`: the newest 100 tokens, oldest first. The sweep deletes each expired token. Each token holds `id`, `name`, `hint`, `scopes`, `createdAt`, `lastUsedAt`, and `expiresAt`. No answer holds the token or its hash |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh) |

<h3 id="post-scim-tokens-create"><code>POST /scim/tokens/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard of [Enterprise SSO](#enterprise-sso) must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ organizationId, name, scopes?, expiresInDays? }`. `name` has 1 to 64 characters with no control character. `scopes` is a non-empty list of distinct scopes of `scim.users.read`, `scim.users.write`, `scim.groups.read`, and `scim.groups.write`; absent gives all four. `expiresInDays` is a whole number from 1 to 730; absent, the token never expires |
| Answer | `{ token, id, hint }`. An organization holds at most 2 live tokens: the one in use and the next one of a rollover. An expired token does not count |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`token_limit`](/docs/reference/errors/#token_limit), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-scim-tokens-revoke"><code>POST /scim/tokens/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The manager guard of [Enterprise SSO](#enterprise-sso) must pass: an owner of the organization, or a platform operator |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }`. The row goes, and the next SCIM call with the token answers 401 |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`operator_required`](/docs/reference/errors/#operator_required), [`second_factor_required`](/docs/reference/errors/#second_factor_required), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

The routes under `/scim/v2` take an `sk_` bearer token as `Authorization: Bearer <token>`, and no session. The organization of each call is the organization of the token, never a value of the path or the body. Each answer is `application/scim+json` with `cache-control: no-store`. A failure is the SCIM error message of RFC 7644 section 3.12, `{ schemas, status, scimType?, detail }`, never a code of the errors page.

A missing, wrong, expired, or revoked token answers 401 with `WWW-Authenticate: Bearer realm="scim"`. Each such failure counts on `scim-auth:ip:<ip>`, 60 per 15 minutes, and a refused count answers 429. A valid token never counts on that key. It counts on `scim:token:<id>`, 1200 per 10 minutes, and a refused count answers 429. A token without the scope of a route answers 403.

<h3 id="get-scim-v2-serviceproviderconfig"><code>GET /scim/v2/ServiceProviderConfig</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | The ServiceProviderConfig of RFC 7643 section 5: PATCH, filters with at most 100 results, and ETags are on; bulk, sort, and the password change are off. The one scheme is `oauthbearertoken`. The extension `urn:authtempo:params:scim:schemas:extension:limits:2.0` states the member caps of the Groups: `groupMembersMax` 10000, `membersPerRequestMax` 1000, and `roleRecomputeMax` 1000. `membersPerRequestMax` counts the members that one request names, and the members that it takes away |
| Errors | None |

<h3 id="get-scim-v2-resourcetypes"><code>GET /scim/v2/ResourceTypes</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | A ListResponse of the resource types `User`, with the enterprise extension as not required, and `Group`. The discovery lists ignore paging and sorting, as RFC 7644 section 4 says. A `filter` answers 403 |
| Errors | None |

<h3 id="get-scim-v2-resourcetypes-id"><code>GET /scim/v2/ResourceTypes/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | The resource type `User` or `Group`. Another id answers 404 |
| Errors | None |

<h3 id="get-scim-v2-schemas"><code>GET /scim/v2/Schemas</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | A ListResponse of the core User, the core Group, and the enterprise User schemas, with the facts of each attribute that core reads or stores. The discovery lists ignore paging and sorting, as RFC 7644 section 4 says. A `filter` answers 403 |
| Errors | None |

<h3 id="get-scim-v2-schemas-id"><code>GET /scim/v2/Schemas/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | The schema of the URN in the path. Another id answers 404 |
| Errors | None |

The Users routes (plan 12d Task 10) serve the SCIM view of the staff of the token's organization. A create, and a change of the address, needs an address in a verified domain of the organization. Each write answers the version as a weak `ETag`, and `If-Match` with another version answers 412.

Core ignores an attribute that the User schema does not know. It stores nothing of it and answers the User as stored. Entra ID and Okta send such attributes from their attribute maps. In a PATCH with no path, core ignores an unknown key of the value in the same way. A path to an unknown attribute answers 400 `invalidPath`.

A schema URN in `schemas` other than the core User and the enterprise extension answers 400 `invalidSyntax`. A custom extension in the attribute map of Entra ID or Okta sends such a URN. To fix it, remove the custom mapping in the directory, or ask for the extension.

A deactivate ends the sessions that fit its call budget. The other sessions stay until the sweep, but each session read, JWT mint, and `sessionLive` call refuses them at once. A deactivate also ends the OAuth refresh tokens of the user. The families that do not fit the budget stay on the pending-end row, and the sweep ends them. Until then the refresh grant and introspection refuse each of them.

After its work, the sweep keeps the pending-end row of a deactivate as the record of the act. Each door still refuses a session or a refresh family of the user that began before the deactivate. This holds also for one that no act or sweep ended. It also holds for one that began in the 5 seconds after the deactivate. That bound covers a server whose clock runs ahead of the clock of the deactivate. The record lives as long as such a session or family can live on any server of the app. That is the longer of `session.ttlDays` and 365 days and 30 minutes, and then one day more. 365 days is the top value of `oauth.refreshTtlDays`, and 30 minutes is the longest code life. Another server of the app can run a longer `oauth.refreshTtlDays`, and write a family that the deactivate does not read. The session life comes from the config at the deactivate or at the sweep, whichever is longer. So a deploy that lowers `session.ttlDays` does not shorten it. Then the sweep deletes it. One deactivate keeps at most one such row per user.

In a PATCH, Entra ID sends the manager as a list of one object. The path is `manager` or the path of the enterprise extension. Core reads that object as the `manager` of the enterprise extension. A list of two or more objects answers 400 `invalidValue`.

A write of a mapped group can change the role of a person while a deactivate or a delete of that person runs. The deactivate then reads the member row again under its user hold. When the role changed, the deactivate runs again with its before hooks. It runs at most 5 rounds. A new round that does not fit the D1 Free budget of 50 queries is a small round. A small round removes the member row and ends no session in the request. It writes one pending-end row that covers every session and OAuth refresh family of the person. Each door refuses them at once, and the sweep ends them. The code exchange and the device poll also refuse an OAuth code or an approved device from before the deprovision. So, apart from the 409 below, the deprovision always ends access at once. A small round also reads the newest OAuth code and approved device row, so its row covers one from a server whose clock runs ahead. A test on D1 deactivated a person with 40 sessions, 3 families, and a `session.afterEnd` hook. After 2 lost rounds, it answered in 46 queries (measured 2026-10-24).

The answer is 409 only when every round is lost, or when no small round fits the D1 Free budget. D1 stops a request at its 51st query, so core does not start that round. An address move and a name fill each add calls to a round, so they leave less room. A round is lost at the member read when a group write changes the role before the deactivate reads the member row again. It is lost at the member delete when the group write comes between that read and the delete. On D1, these cases answer 409 (measured 2026-10-24):

- A deactivate with no address move and no name fill: 3 lost rounds at the member read, or 2 at the member delete.
- A deactivate that also gives a name to a user with no name: 3 lost rounds at the member read.
- A deactivate that also moves the address: 1 lost round at the member read or at the member delete.
- A deactivate that moves the address and gives a name: 1 lost round.
- A delete: 3 lost rounds at the member read, or 2 at the member delete.

Then nothing changes, so the person keeps access. The directory then marks the push as failed. Okta needs an admin to retry a failed deprovision task (Okta docs, read 2026-10-22).

A person can change the address of the account, for example to a personal address. The directory owns the address only while a verified domain of the organization claims it. When no such domain claims the current address, a PUT or a PATCH that changes the address answers 400 `mutability`. A reactivate answers the same, so the member row does not come back. Nothing changes then. A write that sends the address it sent before keeps the address that the person chose. A deactivate and a delete still run.

<h3 id="get-scim-v2-users"><code>GET /scim/v2/Users</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.read` |
| Input | None. The query may hold `filter`, `startIndex`, `count`, `attributes`, or `excludedAttributes`. The filter is one `eq` of `userName`, `externalId`, `emails.value`, or `id`, or the email match of Entra ID: `emails[type eq "<type>"].value eq "<address>"`. That form finds the person at the address, with an email of that type and that value. Both compare with no case |
| Answer | A ListResponse of the Users of the organization, by `id`, at most 100 per page |
| Errors | None |

<h3 id="post-scim-v2-users"><code>POST /scim/v2/Users</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.write` |
| Input | None. The body is a User of RFC 7643 section 4.1, with the enterprise extension at most. Core ignores a `password`: it stores, logs, and answers nothing of it. Okta sends a placeholder password in each create |
| Answer | 201 with the User, `Location`, and `ETag`. The user at the address gets a member row with `scim.defaultRole`, or a new user comes with a verified address and no password |
| Errors | None |

<h3 id="get-scim-v2-users-id"><code>GET /scim/v2/Users/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.read` |
| Input | None. The query may hold `attributes` or `excludedAttributes` |
| Answer | The User, with `ETag`. An id of another organization answers 404 |
| Errors | None |

<h3 id="put-scim-v2-users-id"><code>PUT /scim/v2/Users/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.write` |
| Input | None. The body is a User, and `If-Match` may name the version. Core ignores a `password`, as in a create |
| Answer | The User. `active: false` removes the member row, and ends the access of a user whose address the organization's domain claims. A PUT replaces the whole User (RFC 7644 section 3.5.1). A body with no `active` reads as `active: true`, so it reactivates a deactivated user. A deactivate answers 409 only when group writes race each round, or when no small round fits on D1. Then nothing changes. The paragraphs on these races above list the cases on D1 and say what the directory does then. A new address or a reactivate of a user whose current address no verified domain of the organization claims answers 400 `mutability` |
| Errors | None |

<h3 id="patch-scim-v2-users-id"><code>PATCH /scim/v2/Users/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.write` |
| Input | None. The body is a PatchOp message of RFC 7644 section 3.5.2, and `If-Match` may name the version. A change of `password` answers 400 `invalidValue`, because the password change is off. A remove of `userName`, or a replace of it with null, answers 400 `mutability` |
| Answer | The User. The operations apply together, or none applies. A deactivate answers 409 only when group writes race each round, or when no small round fits on D1. Then nothing changes. The paragraphs on these races above list the cases on D1 and say what the directory does then. When an operation writes a value with `primary` true, each other value of that attribute gets `primary` false. A new address or a reactivate of a user whose current address no verified domain of the organization claims answers 400 `mutability` |
| Errors | None |

<h3 id="delete-scim-v2-users-id"><code>DELETE /scim/v2/Users/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.users.write` |
| Input | None. `If-Match` may name the version |
| Answer | 204 with no body. The deactivate runs first, and the core user stays. A delete answers 409 only when group writes race each round, or on D1 after 3 lost rounds at the member read or 2 at the member delete. Then nothing changes. The paragraphs on these races above say what the directory does then |
| Errors | None |

The Groups routes (plan 12d Task 11) serve the groups of the token's organization. A member of a group is a User of the same organization. A group id, an id of another organization, an unknown id, or a `type` other than `User` answers 400 `invalidValue`. Core serves no nested group. Each member in an answer holds `value`, `$ref`, and `type`.

The caps come from the D1 Free budget of 50 queries per request. One request names at most 1000 members of a group. The count holds the members of a POST or a PUT body, or the values of the operations of a PATCH. It takes away at most 1000 members, so a PUT of 1000 members that replaces 1000 other members passes. The caps are the same on every store: D1, SQLite, Postgres, and MySQL. Core reads, deletes, and updates up to 2000 ids in one statement, and inserts the rows of one request in a few statements. On D1 and SQLite a list binds as one JSON text. A group holds at most 10000 members. A rename or a delete of a mapped group computes the role of each member again, and refuses a group of more than 1000 members. Each refusal is 400 `invalidValue`, and nothing changes.

On D1 a write that fails late, such as at a conflict with an account delete, reverses its own writes in the same request. The budget keeps room for those statements. So a write whose many role changes leave no such room answers 400 `invalidValue`. Its first writes are the group row and the team row, and its undo restores both, so nothing changes. A write whose role changes make 3 or more pairs of an old and a new role can cause it. An Okta push can meet it. Take 999 adds and 1 removal to the mapped group `Admins`. 300 of the added persons hold the role of the mapped group `Web`. The pairs are then `web` to `admin`, `member` to `admin`, and `admin` to `member`. Okta marks such a push failed and does not split it. Push the group in smaller steps then. On D1 (2026-10-24) a push of 500 members with 3 pairs answers 204, and so does a push of 333 members with 4 pairs. The sessions of the persons who leave the team lose its active team in the last write. At a group delete, each session in the team loses it in the last write. So the count of sessions does not change the budget of a POST, a PUT, a PATCH, or a DELETE.

Okta sends up to 1000 members in one group PATCH, and the cap takes that batch. An Okta app of the App Integration Wizard sends a PUT with every member. Such a PUT answers 400 when it holds more than 1000 members, or when it takes away more than 1000 members. Push the group again in smaller steps. Entra ID sends one member in each operation.

The role map gives a role to each member of a mapped group: `scimRoles` of the connection, set by `POST /sso/connections/update` or `api.scim.setRoleMap`. The map of an organization is the map of its enabled connection that it created first. A member gets the highest-ranked role of its mapped groups, else `scim.defaultRole`. SCIM never gives or takes the owner role or the platform role. A mapped role that the organization no longer has answers 409 with the detail `role_not_found`, and nothing changes.

A change of the role map changes no role at once. A member gets the role of the new map at the next change of its groups, or at a rename of a mapped group. A reactivated User gets back the role of its groups, and not the teams. A group write that changes the groups of the User during its reactivate makes the reactivate answer 409, and the directory sends it again. The teams come back at the next member change of each group.

With `scim.groups` set to `teams` or `both`, each group has one team of the organization. A group create creates the team, a rename renames it, a delete deletes it, and a member change is a team member change. These team writes run no team hook. An app that watches the team hooks must also watch `hooks.scim.afterChange`, which reports each group write after its commit. With `keepLastTeam`, the delete of the group of the last team answers 409.

<h3 id="get-scim-v2-groups"><code>GET /scim/v2/Groups</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.read` |
| Input | None. The query may hold `filter`, `startIndex`, `count`, `attributes`, or `excludedAttributes`. The filter is one `eq` of `displayName`, `externalId`, or `id`, or the member check of Entra ID: `id eq "<group>" and members[value eq "<user>"]` |
| Answer | A ListResponse of the Groups of the organization, by `id`, at most 100 per page. `excludedAttributes=members` reads no member row, as Entra ID asks. A page with members holds at most 10000 member rows, as one group does. It ends before the first group that does not fit whole, and `itemsPerPage` gives the count of groups on the page. Ask the next page from `startIndex` plus `itemsPerPage`. On D1 such a page costs 6 queries (measured 2026-10-22) |
| Errors | None |

<h3 id="post-scim-v2-groups"><code>POST /scim/v2/Groups</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.write` |
| Input | None. The body is a Group of RFC 7643 section 4.2. `displayName` is required, 1 to 255 characters, and unique in the organization with no case. `schemas` holds the core Group URN. Entra ID also sends `http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group`, and core reads nothing of it. Another URN answers 400 `invalidSyntax` |
| Answer | 201 with the Group, `Location`, and `ETag`. A second group with the same `displayName` answers 409 `uniqueness` |
| Errors | None |

<h3 id="get-scim-v2-groups-id"><code>GET /scim/v2/Groups/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.read` |
| Input | None. The query may hold `attributes` or `excludedAttributes` |
| Answer | The Group, with `ETag`. An id of another organization answers 404 |
| Errors | None |

<h3 id="put-scim-v2-groups-id"><code>PUT /scim/v2/Groups/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.write` |
| Input | None. The body is a Group, and `If-Match` may name the version |
| Answer | The Group. A PUT replaces the name, the `externalId`, and the whole member list |
| Errors | None |

<h3 id="patch-scim-v2-groups-id"><code>PATCH /scim/v2/Groups/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.write` |
| Input | None. The body is a PatchOp message: `add` and `remove` of `members`, and `replace` of `displayName`, `externalId`, or `members`. A `remove` takes the path `members[value eq "<id>"]` or a list of values. A `remove` of `displayName`, or a `replace` of it with null, answers 400 `mutability`. `If-Match` may name the version |
| Answer | 204 with no body, as RFC 7644 section 3.5.2 allows. With `attributes` in the query, 200 with the Group. The operations apply together, or none applies. A PATCH that changes nothing writes nothing: no new version and no audit row. So a remove of a User that is not a member, by the filter path or by a list of values, answers as a removal does. A directory sends a removal again after a time-out, and an error marks its push as failed |
| Errors | None |

<h3 id="delete-scim-v2-groups-id"><code>DELETE /scim/v2/Groups/:id</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. The token needs the scope `scim.groups.write` |
| Input | None. `If-Match` may name the version |
| Answer | 204 with no body. The member rows and the team of the group go, and each member of a mapped group gets its role again. The Users stay |
| Errors | None |

Core does not serve these SCIM operations. Each answers 501 with the detail "not supported by this server", after the token check.

<h3 id="post-scim-v2-bulk"><code>POST /scim/v2/Bulk</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | 501 with the SCIM error message |
| Errors | None |

<h3 id="get-scim-v2-me"><code>GET /scim/v2/Me</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | 501 with the SCIM error message |
| Errors | None |

<h3 id="post-scim-v2-search"><code>POST /scim/v2/.search</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | 501 with the SCIM error message |
| Errors | None |

<h3 id="post-scim-v2-users-search"><code>POST /scim/v2/Users/.search</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | 501 with the SCIM error message |
| Errors | None |

<h3 id="post-scim-v2-groups-search"><code>POST /scim/v2/Groups/.search</code></h3>

| Field | Value |
| --- | --- |
| Needs | An `sk_` bearer token. Any scope of the token passes |
| Input | None |
| Answer | 501 with the SCIM error message |
| Errors | None |

## Passkey related origins

This route exists when the config sets `passkey` with `relatedOrigins: true`.

<h3 id="get-well-known-webauthn"><code>GET /.well-known/webauthn</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | `{ origins }`, the origins of `passkey.origins` outside the domain tree of `rpID` in config order, with `content-type: application/json` and `cache-control: public, max-age=300`. Only a request to the `rpID` host gets it. The browser reads it at the origin root, so mount [`auth.wellKnown`](/docs/reference/well-known/) there |
| Errors | None. Another host answers `not_found` |

## Username

These routes exist when the config sets `username`. A username is public by design. The stored form is NFKC in lower case and matches `^[a-z0-9_.]+$`; `displayUsername` keeps the case that the person typed. A proof of the address on an unverified account clears the username that the claimant chose. A magic link, a social sign-in, and a reset each prove the address. Only the verify link of the sign-up that named the name keeps it.

<h3 id="get-username-available"><code>GET /username/available</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ username }` |
| Answer | `{ available }`: true when no account holds the stored form of the name |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited), [`username_invalid`](/docs/reference/errors/#username_invalid) |

<h3 id="post-user-username"><code>POST /user/username</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user has a proved handle |
| Input | JSON `{ username }` |
| Answer | `{ username, displayUsername }`. The old name is free at once. A notice goes to the user's address |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`username_invalid`](/docs/reference/errors/#username_invalid), [`username_taken`](/docs/reference/errors/#username_taken), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`impersonation_session`](/docs/reference/errors/#impersonation_session), [`anonymous_refused`](/docs/reference/errors/#anonymous_refused) |

## Multi-session

These routes exist when the config sets `multiSession`. One browser keeps the sessions of several users. The session cookie holds the active token, and the HttpOnly bag cookie `__Host-tempo_sessions` holds the others. A browser sign-in of another user moves the old session into the bag. A sign-in of the same user ends the old session. An anonymous session never enters the bag, and these routes serve it. A sign-in over it upgrades the anonymous user, and the anonymous session ends with `anonymous_upgrade`, never `displaced`. A switch is no sign-in: it links nothing, and the anonymous session stays until it expires. Each route resolves each token of the bag, so a revoked, expired, or banned session leaves the bag cookie in the same answer. The read of a bag token never slides its expiry: a list does not keep an idle session alive. A switch reads the new active session as any request does. A token of the bag signs no request in. A request with the Bearer scheme answers 401: a bearer client has no bag. Another scheme, such as HTTP Basic in front of the site, does not refuse a browser. No answer holds a token.

Two limits remain. When the active session ends elsewhere, these routes answer 401, and the browser reaches its bag only after a new sign-in. An anonymous sign-in needs no credential, and it makes such a stranded bag reachable again. On a shared computer, `POST /sign-out` clears the bag. A session that a SCIM deactivate revoked keeps its place in the bag until the next list or switch. Until then, a sign-in can displace a live session in its place.

<h3 id="get-multi-session"><code>GET /multi-session</code></h3>

| Field | Value |
| --- | --- |
| Needs | The session cookie of a browser only. A request with the Bearer scheme answers 401 |
| Input | None |
| Answer | `{ sessions }`: the active session first, then each live session of the bag. Each has `sessionId`, `active`, and `user` with `id`, `name`, `email`, `username`, and `image` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-multi-session-switch"><code>POST /multi-session/switch</code></h3>

| Field | Value |
| --- | --- |
| Needs | The session cookie of a browser only. A request with the Bearer scheme answers 401 |
| Input | JSON `{ sessionId }`. The id of a session of the bag |
| Answer | `{ user, session }` of the new active session. The session cookie takes its token, and the old active session moves into the bag. A switch makes no session fresh. An id of no live session of this browser answers `not_found` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

<h3 id="post-multi-session-sign-out"><code>POST /multi-session/sign-out</code></h3>

| Field | Value |
| --- | --- |
| Needs | The session cookie of a browser only. A request with the Bearer scheme answers 401 |
| Input | JSON `{ sessionId }`. The id of the active session or of a session of the bag |
| Answer | `{ ok: true }`. Only that session ends. When it is the active one, the first live session of the bag becomes active, or the session cookie is cleared. An id of no live session of this browser answers `not_found` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body), [`impersonation_session`](/docs/reference/errors/#impersonation_session) |

## OpenAPI document

This route exists when the config sets `openapi: true`.

<h3 id="get-openapi-json"><code>GET /openapi.json</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | The OpenAPI 3.1 document of the routes that the config turns on |
| Errors | None |

## Health and readiness

`GET /health` exists in every deployment. `GET /ready` exists when the config sets `observe.readiness: true`. Neither route counts on a limiter, and an impersonation session can call both.

<h3 id="get-health"><code>GET /health</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | `{ status: "ok" }` with `cache-control: no-store`. It reads no storage, so it answers while the store is down |
| Errors | None |

<h3 id="get-ready"><code>GET /ready</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | `{ status: "ready" }` when the store answers. It calls `storage.ping()`, which reads the schema version with no cache; an adapter with no `ping` gets one read of a user row. One result holds for 10 seconds for each `Auth` instance |
| Errors | [`not_ready`](/docs/reference/errors/#not_ready) 503 with `reason`: `storage` when the store throws or gives no answer in 3 seconds, `schema` for an old schema version. The body names no host, no database, no version, and no error name |

## Next

- [Error codes](/docs/reference/errors/)
- [The client package](/docs/reference/client/)
- [Limits](/docs/reference/limits/)
