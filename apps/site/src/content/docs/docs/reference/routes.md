---
title: Routes
description: Every route that core serves under basePath, with what it needs, what it takes, what it answers, and its error codes.
type: reference
sources:
  - packages/core/README.md "Routes under"
  - packages/core/src/http/route-list.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
  - docs/superpowers/plans/2026-10-14-11g-openapi.md
---

**For:** a developer who calls the routes of core, or checks what a route answers.

**What it does:** this page lists every route of core, one anchor for each. A path is relative to `basePath`, which is `/auth` by default. The same routes are in the OpenAPI document at [`/docs/reference/openapi.json`](/docs/reference/openapi.json).

## Before you start

- Read [Configuration](/docs/reference/config/) for the keys that turn each group of routes on.

## The rules of every route

- A route that a config key turns off answers 404 `not_found`.
- A POST with an `Origin` header that is not `baseURL` and not in `trustedOrigins` answers 403 `origin_not_trusted`. Two routes are exceptions: Apple's form post callback, and the token endpoint, which states its own rule.
- A failure answers `{ "error": "<code>" }` with the status of the code. `hook_refused` also carries `message`.
- An unhandled error answers 500 [`internal`](/docs/reference/errors/#internal) and writes one log line.
- An `OPTIONS` preflight from a trusted origin answers 204 with the CORS headers. A preflight from another origin answers 403, except where a route states its own rule.
- Every answer to a trusted origin carries the CORS headers with credentials.
- The Errors cell of a route does not repeat `not_found`, `origin_not_trusted`, and `internal`, the codes of the router. A route also answers `not_found` for a record that it names and does not find.
- The Needs cell names each credential form that the route takes. "A session cookie, or a `ts_` bearer token" is a session in either form.

## Sessions

These routes exist in every deployment.

<h3 id="get-session"><code>GET /session</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ user, session }`; a sliding refresh renews the cookie. With `session.deferRefresh` on, the answer adds `needsRefresh`, and the route writes nothing and renews no cookie |
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
| Answer | `{ ok: true }`, and the cookie is cleared |
| Errors | None |

## Account

These routes serve a settings page (plan 12a). They exist in every deployment unless a row names a feature. A fresh session is one that a sign-in or a re-authentication proved within `session.freshMinutes`.

<h3 id="post-reauth"><code>POST /reauth</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | JSON `{ password?, emailCode?, passkey?, code? }`. One first proof: `{ password, code? }`, `{ emailCode, code? }`, or `{ passkey }`. `code` is an authenticator code or a backup code, required after a password or an email code while the second factor is on. A passkey proves two factors and takes no `code`. With the email method only, `code` is a backup code: the email method as a re-authentication code is a later input. A user whose password row holds the legacy marker proves by an email code or a passkey. With `emailOtp` off or no `passkey` config, that proof answers `not_found` and the limit counts no try |
| Answer | `{ freshUntil }`, an ISO date. The session token and the expiry stay the same |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled) |

<h3 id="post-reauth-email"><code>POST /reauth/email</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. `emailOtp` is on |
| Input | None. The route reads no body |
| Answer | `{ sent: true }`. A code goes to the user's address. Send it to `POST /reauth` as `emailCode` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-reauth-passkey-options"><code>POST /reauth/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The `passkey` config is set |
| Input | None. The route reads no body |
| Answer | The request options for `navigator.credentials.get`, with the user's passkeys. Send the assertion to `POST /reauth` as `passkey` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-sessions"><code>GET /sessions</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ sessions }`: the live sessions of the user, newest first, at most 100. Each has `id`, `createdAt`, `lastSeenAt`, `expiresAt`, `freshAt`, `ip`, `userAgent`, `activeOrganizationId`, and `current`. `lastSeenAt` moves only at the sliding refresh. `expiresAt` is the earlier of the row's expiry and the absolute cap |
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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-user-change-email"><code>POST /user/change-email</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user is verified |
| Input | JSON `{ newEmail, method?, next? }`. `method` is `link` (the default) or `code`, which needs `emailOtp`. Any other field is refused |
| Answer | `{ sent: true }`. A proof goes to the new address. When any user holds that address, a note goes there in place of the proof, with the same answer. A new request spends the earlier proof |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`email_taken`](/docs/reference/errors/#email_taken), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`hook_refused`](/docs/reference/errors/#hook_refused), [`last_credential`](/docs/reference/errors/#last_credential), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-user-delete"><code>POST /user/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and `account.delete` is on (the default) |
| Input | JSON `{}`. Any field answers `invalid_body` |
| Answer | `{ ok: true }`. The session cookie is cleared. The user and every row that names it go. An organization where the user is the only member goes too, and a notice goes to the address. With `account.deleteConfirm` on, the answer is `{ sent: true }`: a link goes to the address, and nothing is deleted |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`hook_refused`](/docs/reference/errors/#hook_refused), [`sole_owner`](/docs/reference/errors/#sole_owner), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed) |

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
| Answer | A form: 302 to the app, or to `?auth_error=<code>` on a failure. JSON: `{ ok: true }`. Both clear the session cookie. The delete of `POST /user/delete` runs |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`sole_owner`](/docs/reference/errors/#sole_owner), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_failed`](/docs/reference/errors/#hook_failed) |

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
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict) |

## Social sign-in

These routes exist for each configured provider. `:provider` is the name of the provider, such as `google`, `github`, or a list entry.

<h3 id="get-social-provider-start"><code>GET /social/:provider/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ next? }` |
| Answer | 302 to the provider, with the binding cookie `__Secure-tempo_session_oauth`. A failure redirects to `/?auth_error=<code>` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed) |

<h3 id="post-social-provider-link"><code>POST /social/:provider/link</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the user is verified. The callback needs the binding cookie and the session cookie of that session. Apple's form post needs no session cookie while it is `Lax` |
| Input | JSON or form `{ next? }` |
| Answer | JSON: `{ url }` and the binding cookie; the client navigates to `url`. A form: 303 to the provider. The callback links the identity to the session's user and redirects to `next`. It sets no session cookie. A failure at the callback redirects to `/?auth_error=<code>` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_body`](/docs/reference/errors/#invalid_body), [`email_unverified`](/docs/reference/errors/#email_unverified), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed). The callback answers the codes of [`GET /social/:provider/callback`](#get-social-provider-callback) |

<h3 id="get-social-provider-callback"><code>GET /social/:provider/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The callback reads the binding cookie |
| Input | Query `{ code?, state?, error? }`. `code` and `state`, or `error`, come from the provider. The browser sends the trust cookie of a trusted device |
| Answer | 302 to `appURL` plus `next`, with the session cookie. For a user with the second factor on, a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge) with no session cookie. A failure redirects to `/?auth_error=<code>` |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`identity_taken`](/docs/reference/errors/#identity_taken), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="post-social-apple-callback"><code>POST /social/apple/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. The callback reads the binding cookie. The Origin check is skipped |
| Input | JSON or form `{ code?, state?, error?, user?, id_token? }`. Apple sends a form with `code`, `state`, and `user?` |
| Answer | The same as the GET callback. A cross-site post carries no trust cookie, so a user with the second factor on goes to the challenge page, which offers the trusted device |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`identity_taken`](/docs/reference/errors/#identity_taken), [`conflict`](/docs/reference/errors/#conflict) |

## Passkeys

These routes exist when the config sets `passkey`.

<h3 id="post-passkey-register-options"><code>POST /passkey/register/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified |
| Input | None |
| Answer | The creation options JSON for `navigator.credentials.create` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-passkey-register-verify"><code>POST /passkey/register/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ response, name? }`. A `name` that is blank after the trim, or that breaks the rule of [`POST /passkeys/rename`](#post-passkeys-rename), is stored as no name. The registration never refuses a credential for its name |
| Answer | `{ passkey }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-passkey-authenticate-options"><code>POST /passkey/authenticate/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None. The route reads no body |
| Answer | The request options JSON for `navigator.credentials.get` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-passkey-authenticate-verify"><code>POST /passkey/authenticate/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ response }` |
| Answer | `{ user, session }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="get-passkeys"><code>GET /passkeys</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, createdAt }] }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-passkeys-delete"><code>POST /passkeys/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`second_factor_last_method`](/docs/reference/errors/#second_factor_last_method), [`last_credential`](/docs/reference/errors/#last_credential), [`conflict`](/docs/reference/errors/#conflict) |

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
| Input | JSON `{ email, password, name? }` |
| Answer | 200 `{ sent: true }` with no cookie, for every address. The verify link opens the session. With `password.uniformSignUp: false`: a session with the cookie, or 409. With `uniformSignUp: false` and `password.requireVerified` on, or with `signUp: "invited"`: `{ user, verifyRequired: true }` with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`email_taken`](/docs/reference/errors/#email_taken), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`conflict`](/docs/reference/errors/#conflict) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="post-password-sign-in"><code>POST /password/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, trustDevice?, next? }` |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie for a user with the second factor on |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

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
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="post-password-verify-resend"><code>POST /password/verify/resend</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address; the earlier link of the address stops |
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
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="post-password-change"><code>POST /password/change</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified. A first password, and a change while the second factor is on, need a fresh session |
| Input | JSON `{ currentPassword?, newPassword }` |
| Answer | `{ ok: true }`; every other session ends |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Second factor

These routes exist when the config sets `password` and `totp` is not `false`.

<h3 id="post-totp-setup"><code>POST /totp/setup</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ password }` |
| Answer | `{ secret, uri, backupCodes }`, each answered once. `backupCodes` is empty when another method is on, because the factor keeps its list |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-enable"><code>POST /totp/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified |
| Input | JSON `{ code }` |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`, as `GET /totp`. As the first method, it ends every other session. `totp_not_enabled` means no setup, a setup older than 15 minutes, or a setup whose codes another method made stale: set up again |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-disable"><code>POST /totp/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ code }`. `code` is a current code or a backup code |
| Answer | `{ ok: true }`, and the trust cookie is cleared. It turns the TOTP method off. With no method left, the factor is off |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-backup-codes"><code>POST /totp/backup-codes</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ code }` |
| Answer | `{ backupCodes }`, a new list; the old codes stop |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-totp"><code>GET /totp</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`; never the secret. `enabled` is true when any method is on. `backupCodesVersion` is 1 for the codes of plan 9f, 2 for the codes of 23 characters, and `null` with the factor off |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-totp-devices-revoke"><code>POST /totp/devices/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ ok: true }`; every trusted device of the user goes |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-totp-verify"><code>POST /totp/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ challenge, code?, backupCode?, emailCode?, passkey?, trustDevice? }`. The body has one of `code`, `backupCode`, `emailCode`, or `passkey`. `passkey` is an assertion over the options of [`POST /second-factor/passkey/options`](/docs/reference/routes/#post-second-factor-passkey-options). |
| Answer | `{ token, user, session, next, backupCodesLeft, trustDevice }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="get-totp-challenge"><code>GET /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ challenge, method?, backup?, error? }` |
| Answer | 200, the form of the challenge's methods, with a trusted-device button when the browser sends a live trust cookie of the user. It reads rows and writes none. A malformed or dead challenge redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-totp-challenge"><code>POST /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON or form `{ challenge, code?, backupCode?, emailCode?, trustDevice?, action? }`. A form post sends `code`, `backupCode`, or `emailCode` with `trustDevice=1`; or `action=send-email`; or `action=trusted` |
| Answer | 302 to `next` with the cookies. Back to the form on a wrong code and after a send. `action=trusted` passes with the trust cookie alone |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`conflict`](/docs/reference/errors/#conflict), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-second-factor-passkey-enable"><code>POST /second-factor/passkey/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, the address is verified, and the `passkey` config is set |
| Input | JSON `{ password, response }`. `response` is an assertion over the options of [`POST /passkey/authenticate/options`](/docs/reference/routes/#post-passkey-authenticate-options) by a passkey of the user |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-passkey-options"><code>POST /second-factor/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A live challenge that offers `passkey`, and the `passkey` config |
| Input | JSON `{ challenge }` |
| Answer | WebAuthn request options with the user's passkeys in `allowCredentials`, bound to this challenge |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-disable"><code>POST /second-factor/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh |
| Input | JSON `{ method, password }`. `method` is `passkey` or `email` |
| Answer | `{ ok: true, methods }`, the methods left. With none left, the factor is off and the trust cookie is cleared. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-email-enable"><code>POST /second-factor/email/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified |
| Input | JSON `{ password }` |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-email-send"><code>POST /second-factor/email/send</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A live challenge of a password sign-in that offers `email` |
| Input | JSON `{ challenge }` |
| Answer | `{ sent: true }`. A 6-digit code goes to the user's address. It lives with the challenge, and a new send replaces it. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`conflict`](/docs/reference/errors/#conflict) |

## Handoff

These routes exist when the config sets `handoff`.

<h3 id="get-handoff-start"><code>GET /handoff/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token |
| Input | Query `{ challenge, redirect }` |
| Answer | 200, the sign-in page, or 302 to the confirm page when the browser has a session |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-handoff-continue"><code>GET /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. The confirm page needs the session |
| Input | Query `{ h }` |
| Answer | 200, the confirm page, or the sign-in page without a session |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-handoff-continue"><code>POST /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. The confirm needs the session, and `Origin` equal to `baseURL` |
| Input | JSON or form `{ h }` |
| Answer | 302 to `<redirect>?code=` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-handoff-redeem"><code>POST /handoff/redeem</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ code, verifier }` |
| Answer | `{ token, user, session }` as a bearer answer, with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

## Organizations

These routes exist when the config sets `organizations`. A write that runs an organization hook also answers the hook codes. The Errors row of each route names its codes.

<h3 id="post-organizations-create"><code>POST /organizations/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ slug, name, metadata? }` |
| Answer | `{ organization, member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`organization_limit`](/docs/reference/errors/#organization_limit), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-delete"><code>POST /organizations/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `owner` |
| Input | JSON `{ organizationId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

<h3 id="post-organizations-members-role"><code>POST /organizations/members/role</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, userId, role }` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-members-remove"><code>POST /organizations/members/remove</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin`, or is the member |
| Input | JSON `{ organizationId, userId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-invite"><code>POST /organizations/invite</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The user has the rank `admin` |
| Input | JSON `{ organizationId, email, role }` |
| Answer | `{ invitation }`, with no token |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invitation_limit`](/docs/reference/errors/#invitation_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

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
| Answer | `{ organization, member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict) |

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
| Answer | `{ user, session }` with `session.activeOrganizationId` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

## API tokens

These routes exist in every deployment.

<h3 id="post-tokens"><code>POST /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is fresh, and the address is verified. A token of another form answers 401 |
| Input | JSON `{ name, expiresInDays?, organizationId? }` |
| Answer | `{ token, apiToken }`; the clear token appears once |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`email_unverified`](/docs/reference/errors/#email_unverified), [`token_limit`](/docs/reference/errors/#token_limit), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-tokens"><code>GET /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | None |
| Answer | `{ tokens: [{ id, name, hint, expiresAt, lastUsedAt, organizationId, createdAt }] }`, newest first |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-tokens-revoke"><code>POST /tokens/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The address is verified |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="get-tokens-current"><code>GET /tokens/current</code></h3>

| Field | Value |
| --- | --- |
| Needs | A `tk_` bearer token. No other credential |
| Input | None |
| Answer | `{ user, apiToken }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

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
| Answer | `{ live: true }` while the session of the JWT's `sid` claim exists and is not expired, else `{ live: false }`; it counts on `token-live:session:<sessionId>`, 120 per minute ([Limits](/docs/reference/limits/)) |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Operator

These routes exist when the config sets `operator`. `POST /operator/keys/rotate` also needs `jwtMint`. Each answers counts and key names, never a sealed value, a hash, or a config value.

<h3 id="post-operator-keys-rotate"><code>POST /operator/keys/rotate</code></h3>

| Field | Value |
| --- | --- |
| Needs | The operator secret. `Authorization: Operator <secret>`, the secret whose SHA-256 is `operator.secretHash`. The secret must be 32 to 512 visible ASCII characters, and any other secret answers 401 with no reason. |
| Input | None |
| Answer | `{ kid }`, the id of the new signing key. The old key verifies for 24 hours and signs nothing |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-operator-secrets-status"><code>GET /operator/secrets/status</code></h3>

| Field | Value |
| --- | --- |
| Needs | `Authorization: Operator <secret>`, as `POST /operator/keys/rotate` |
| Input | None |
| Answer | `{ versions }`: for each version, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, and `emailCodes`, the answer of `api.secrets.status()`. It counts on `operator-secrets:ip:<ip>`, 120 per hour with rewrap and info, right or wrong secret ([Limits](/docs/reference/limits/)) |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-operator-secrets-rewrap"><code>POST /operator/secrets/rewrap</code></h3>

| Field | Value |
| --- | --- |
| Needs | `Authorization: Operator <secret>`, as `POST /operator/keys/rotate` |
| Input | `{ limit?, after? }`: `limit` a whole number from 1 to 1000, default 100; `after` the `next` of the last answer, so a pass reads each row once. An empty body is `{}`. Another key, a limit of another form, or a cursor that is not `totp:<id>` or `jwk:<id>`, answers `invalid_body` |
| Answer | `{ resealed, failed, skipped, more, next }`, the answer of `api.secrets.rewrap({ limit, after })`: the rows this call moved to the current version, the rows that did not open or did not write, the live setups it left, whether a row under a configured old version remains, and the cursor. It counts on `operator-secrets:ip:<ip>` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-operator-info"><code>GET /operator/info</code></h3>

| Field | Value |
| --- | --- |
| Needs | `Authorization: Operator <secret>`, as `POST /operator/keys/rotate` |
| Input | None |
| Answer | `{ core, schemaVersion, configKeys }`: the version of core, its schema version, and the sorted key paths of the config, for example `operator.secretHash`. Names only: no value, no hash, and no member of `storage`, `mail`, `limiter`, `clock`, `jwt`, `webauthn`, or `clientIp`. It counts on `operator-secrets:ip:<ip>` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## OAuth provider

These routes exist when the config sets `oauth`. They answer the codes of the OAuth table, except where a code of the core table is named.

<h3 id="post-oauth-register"><code>POST /oauth/register</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. `oauth.registration.dynamic` is on |
| Input | JSON `{ redirect_uris, client_name?, token_endpoint_auth_method?, grant_types?, response_types? }`. The client metadata of RFC 7591 |
| Answer | 201 `{ client_id, client_id_issued_at, client_name?, redirect_uris, token_endpoint_auth_method, grant_types, response_types }` |
| Errors | [`invalid_redirect_uri`](/docs/reference/errors/#oauth-invalid_redirect_uri), [`invalid_client_metadata`](/docs/reference/errors/#oauth-invalid_client_metadata), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-authorize"><code>GET /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; or a session cookie, or a `ts_` bearer token. With no session, the route holds the request for a sign-in |
| Input | Query `{ response_type?, client_id?, redirect_uri?, code_challenge?, code_challenge_method?, scope?, resource?, state?, nonce?, prompt?, request_id? }`. The first form holds the OAuth 2.1 parameters with PKCE S256, `resource`, `scope`, `state`, `nonce`, and `prompt`. The second form is `request_id` alone |
| Answer | 302 to `/oauth/sign-in`; 200, the consent page; or 302 to the client with `code`, `state`, and `iss` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_response_type`](/docs/reference/errors/#oauth-unsupported_response_type), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`login_required`](/docs/reference/errors/#oauth-login_required), [`consent_required`](/docs/reference/errors/#oauth-consent_required), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-authorize"><code>POST /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token. The session is of the user that the held request names. `Origin` equals `baseURL` |
| Input | Form `{ request_id, decision }`. `decision` is `allow` or `deny` |
| Answer | 302 to the client with `code`, or with `error=access_denied` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`unsupported_response_type`](/docs/reference/errors/#oauth-unsupported_response_type), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope) |

<h3 id="get-oauth-sign-in"><code>GET /oauth/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Query `{ next }`. `next` is `<basePath>/oauth/authorize?…` |
| Answer | 200, the sign-in page, which lands back on `next`; another `next` redirects to `/?auth_error=invalid_request` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request) |

<h3 id="post-oauth-token"><code>POST /oauth/token</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A browser on a foreign origin needs that origin in a redirect URI of the client that the form names. Its answer then carries `access-control-allow-origin` and no credentials. An origin of `trustedOrigins` gets that header with credentials. `POST /oauth/revoke` still answers 403 to a cross-site form post. A preflight from that origin names the client in `?client_id=` |
| Input | Form `{ grant_type, client_id, code?, code_verifier?, redirect_uri?, resource?, refresh_token?, scope? }`. `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `resource?`; or `grant_type=refresh_token` with `refresh_token`, `client_id`, `scope?`, `resource?` |
| Answer | `{ access_token, token_type: "Bearer", expires_in, scope, refresh_token?, id_token? }` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_grant`](/docs/reference/errors/#oauth-invalid_grant), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_grant_type`](/docs/reference/errors/#oauth-unsupported_grant_type), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-revoke"><code>POST /oauth/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | Form `{ token, client_id? }`. RFC 7009 |
| Answer | 200 `{}` for any token; a refresh token's family goes |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-userinfo"><code>GET /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token of the OAuth provider as the bearer. The token has the scope `openid` |
| Input | None |
| Answer | `{ sub, email?, email_verified?, name?, picture? }` by scope |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope) |

<h3 id="post-oauth-userinfo"><code>POST /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token of the OAuth provider as the bearer. The token has the scope `openid` |
| Input | None |
| Answer | The same as the GET |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized) |

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

## OpenAPI document

This route exists when the config sets `openapi: true`.

<h3 id="get-openapi-json"><code>GET /openapi.json</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | None |
| Answer | The OpenAPI 3.1 document of the routes that the config turns on |
| Errors | None |

## Next

- [Error codes](/docs/reference/errors/)
- [The client package](/docs/reference/client/)
- [Limits](/docs/reference/limits/)
