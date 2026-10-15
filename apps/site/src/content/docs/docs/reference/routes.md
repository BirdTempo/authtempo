---
title: Routes
description: Every route that core serves under basePath, with what it needs, what it takes, what it answers, and its error codes.
type: reference
sources:
  - packages/core/README.md "Routes under"
  - packages/core/src/http/route-list.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
---

**For:** a developer who calls the routes of core, or checks what a route answers.

**What it does:** this page lists every route of core, one anchor for each. A path is relative to `basePath`, which is `/auth` by default.

## Before you start

- Read [Configuration](/docs/reference/config/) for the keys that turn each group of routes on.

## The rules of every route

- A route that a config key turns off answers 404 `not_found`.
- A POST with an `Origin` header that is not `baseURL` and not in `trustedOrigins` answers 403 `origin_not_trusted`.
- A failure answers `{ "error": "<code>" }` with the status of the code. `hook_refused` also carries `message`.
- An unhandled error answers 500 `{ "error": "internal" }` and writes one log line.

## Sessions

These routes exist in every deployment.

<h3 id="get-session"><code>GET /session</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ user, session }`; a sliding refresh renews the cookie |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-sign-out"><code>POST /sign-out</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session cookie, or a `ts_` bearer token |
| Input | None |
| Answer | `{ ok: true }`, and the cookie is cleared |
| Errors | None |

## Account

These routes serve a settings page (plan 12a). They exist in every deployment unless a row names a feature. A fresh session is one that a sign-in or a re-authentication proved within `session.freshMinutes`.

<h3 id="post-reauth"><code>POST /reauth</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON with one first proof: `{ password, code? }`, `{ emailCode, code? }`, or `{ passkey }`. `code` is an authenticator code or a backup code, required after a password or an email code while the second factor is on. A passkey proves two factors and takes no `code`. With the email method only, `code` is a backup code: the email method as a re-authentication code is a later input. A user whose password row holds the legacy marker proves by an email code or a passkey. With `emailOtp` off or no `passkey` config, that proof answers `not_found` and the limit counts no try |
| Answer | `{ freshUntil }`, an ISO date. The session token and the expiry stay the same |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`invalid_token`](/docs/reference/errors/#invalid_token), [`not_found`](/docs/reference/errors/#not_found), [`token_expired`](/docs/reference/errors/#token_expired), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts) |

<h3 id="post-reauth-email"><code>POST /reauth/email</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session, and `emailOtp` on |
| Input | JSON `{}` |
| Answer | `{ sent: true }`. A code goes to the user's address. Send it to `POST /reauth` as `emailCode` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-reauth-passkey-options"><code>POST /reauth/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session, and `passkey` set |
| Input | JSON `{}` |
| Answer | The request options for `navigator.credentials.get`, with the user's passkeys. Send the assertion to `POST /reauth` as `passkey` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-sessions"><code>GET /sessions</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | None |
| Answer | `{ sessions }`: the live sessions of the user, newest first, at most 100. Each has `id`, `createdAt`, `lastSeenAt`, `expiresAt`, `freshAt`, `ip`, `userAgent`, `activeOrganizationId`, and `current`. `lastSeenAt` moves only at the sliding refresh. `expiresAt` is the earlier of the row's expiry and the absolute cap |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-sessions-revoke"><code>POST /sessions/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A fresh session |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }`. The caller's own id also clears the session cookie. A session JWT of that session lives to its `exp` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`not_found`](/docs/reference/errors/#not_found), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-sessions-revoke-others"><code>POST /sessions/revoke-others</code></h3>

| Field | Value |
| --- | --- |
| Needs | A fresh session |
| Input | None |
| Answer | `{ ended }`, the count of live sessions that the call ended. Every other session, the second-factor challenges, and the handoff codes go. A row past its expiry or the absolute cap goes too, with no count and no `revoked` event. The trusted devices, the API tokens, and the OAuth grants stay |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`session_not_fresh`](/docs/reference/errors/#session_not_fresh), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-user-update"><code>POST /user/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session of a verified user. No fresh rule |
| Input | JSON `{ name?, image? }`. `name`: 1 to 200 characters with no control character, no line or paragraph separator, no format character, and no lone surrogate, or null. A bidi control and a zero-width space are format characters. The zero-width non-joiner and joiner pass. `image`: an `https://` URL with a host, of at most 2048 characters, or null. The image has no `@` and no `%` in its authority. It holds no whitespace, no control or format character, no backslash, and none of `"<>{}\|^` or a backtick. Any other field is refused, the address too |
| Answer | `{ user }`: the `id`, `email`, `emailVerified`, `name`, and `image` of the stored row. Only the given fields change |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Input | `?token=` |
| Answer | 200, the confirm page; no side effect. A malformed token redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-magic-link-verify"><code>POST /magic-link/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form or JSON `token`, and JSON `trustDevice?`, the `td_` token of a trusted device. A browser sends the trust cookie |
| Answer | A form: 302 to `appURL` plus `next`, with the cookie. JSON: `{ user, session }` with the cookie. For a user with the second factor on, no cookie: a form gets a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge), and JSON gets `{ twoFactor: { challenge, expiresAt, methods } }` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

## Social sign-in

These routes exist for each configured provider. `:provider` is the name of the provider, such as `google`, `github`, or a list entry.

<h3 id="get-social-provider-start"><code>GET /social/:provider/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?next=` |
| Answer | 302 to the provider, with the binding cookie `__Secure-tempo_session_oauth`. A failure redirects to `/?auth_error=<code>` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed) |

<h3 id="get-social-provider-callback"><code>GET /social/:provider/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | The binding cookie |
| Input | `?code&state`, or `?error` from the provider. The browser sends the trust cookie of a trusted device |
| Answer | 302 to `appURL` plus `next`, with the session cookie. For a user with the second factor on, a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge) with no session cookie. A failure redirects to `/?auth_error=<code>` |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

<h3 id="post-social-apple-callback"><code>POST /social/apple/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | The binding cookie; the Origin check is skipped |
| Input | A form `code`, `state`, and `user?` from Apple |
| Answer | The same as the GET callback. A cross-site post carries no trust cookie, so a user with the second factor on goes to the challenge page, which offers the trusted device |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

## Passkeys

These routes exist when the config sets `passkey`.

<h3 id="post-passkey-register-options"><code>POST /passkey/register/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | None |
| Answer | The creation options JSON for `navigator.credentials.create` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-passkey-register-verify"><code>POST /passkey/register/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ response, name? }` |
| Answer | `{ passkey }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-passkey-authenticate-options"><code>POST /passkey/authenticate/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{}` |
| Answer | The request options JSON for `navigator.credentials.get` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-passkey-authenticate-verify"><code>POST /passkey/authenticate/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ response }` |
| Answer | `{ user, session }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="get-passkeys"><code>GET /passkeys</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | None |
| Answer | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, createdAt }] }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-passkeys-delete"><code>POST /passkeys/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`second_factor_last_method`](/docs/reference/errors/#second_factor_last_method), [`conflict`](/docs/reference/errors/#conflict) |

## Passwords

These routes exist when the config sets `password`.

<h3 id="post-password-sign-up"><code>POST /password/sign-up</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, name? }` |
| Answer | 200 `{ sent: true }` with no cookie, for every address. The verify link opens the session. With `password.uniformSignUp: false`: a session with the cookie, or 409. With `uniformSignUp: false` and `password.requireVerified` on, or with `signUp: "invited"`: `{ user, verifyRequired: true }` with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`email_taken`](/docs/reference/errors/#email_taken) and [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified) only with `password.uniformSignUp: false`, [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="post-password-sign-in"><code>POST /password/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, trustDevice?, next? }` |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt, methods } }` with no cookie for a user with the second factor on |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`captcha_required`](/docs/reference/errors/#captcha_required), [`captcha_failed`](/docs/reference/errors/#captcha_failed), [`captcha_unavailable`](/docs/reference/errors/#captcha_unavailable) |
| Captcha | With `captcha`: the header `x-captcha-response`, after the per-IP limit and before the per-email limits |

<h3 id="get-password-verify"><code>GET /password/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?token=` |
| Answer | 200, the confirm page; no side effect |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-password-verify"><code>POST /password/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form or JSON `token` |
| Answer | A form: 302 to `appURL` with the cookie. JSON: `{ verified: true }`, with the cookie when the address was unverified |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

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
| Input | `?token=` |
| Answer | 200, the reset form; no side effect |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-password-reset"><code>POST /password/reset</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form or JSON `token` and `password`, and JSON `trustDevice?` |
| Answer | A form: 302 to `next` with the cookie, or back to the form. JSON: `{ token, user, session }` with the cookie. For a user with the second factor on, the reset still sets the password and ends every session, then answers no cookie: a form gets a 302 to [the challenge page](/docs/reference/routes/#get-totp-challenge), and JSON gets `{ twoFactor: { challenge, expiresAt, methods } }` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

<h3 id="post-password-change"><code>POST /password/change</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ currentPassword?, newPassword }` |
| Answer | `{ ok: true }`; every other session ends |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Second factor

These routes exist when the config sets `password` and `totp` is not `false`.

<h3 id="post-totp-setup"><code>POST /totp/setup</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ password }` |
| Answer | `{ secret, uri, backupCodes }`, each answered once. `backupCodes` is empty when another method is on, because the factor keeps its list |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-enable"><code>POST /totp/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ code }` |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`, as `GET /totp`. As the first method, it ends every other session. `totp_not_enabled` means no setup, a setup older than 15 minutes, or a setup whose codes another method made stale: set up again |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-disable"><code>POST /totp/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON `{ code }`, a current code or a backup code |
| Answer | `{ ok: true }`, and the trust cookie is cleared. It turns the TOTP method off. With no method left, the factor is off |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-backup-codes"><code>POST /totp/backup-codes</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON `{ code }` |
| Answer | `{ backupCodes }`, a new list; the old codes stop |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-totp"><code>GET /totp</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | None |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices, methods, backupCodesVersion }`; never the secret. `enabled` is true when any method is on. `backupCodesVersion` is 1 for the codes of plan 9f, 2 for the codes of 23 characters, and `null` with the factor off |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-totp-devices-revoke"><code>POST /totp/devices/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | None |
| Answer | `{ ok: true }`; every trusted device of the user goes |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-totp-verify"><code>POST /totp/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ challenge }` with one of `code`, `backupCode`, `emailCode`, or `passkey`, and `trustDevice?`. `passkey` is an assertion over the options of [`POST /second-factor/passkey/options`](/docs/reference/routes/#post-second-factor-passkey-options). |
| Answer | `{ token, user, session, next, backupCodesLeft, trustDevice }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="get-totp-challenge"><code>GET /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?challenge=` |
| Answer | 200, the form of the challenge's methods, with a trusted-device button when the browser sends a live trust cookie of the user. It reads rows and writes none. A malformed or dead challenge redirects to `/?auth_error=invalid_token` |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-totp-challenge"><code>POST /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form `challenge`, and `code`, `backupCode`, or `emailCode` with `trustDevice=1`; or `action=send-email`; or `action=trusted` |
| Answer | 302 to `next` with the cookies. Back to the form on a wrong code and after a send. `action=trusted` passes with the trust cookie alone |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`conflict`](/docs/reference/errors/#conflict), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-second-factor-passkey-enable"><code>POST /second-factor/passkey/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session, a verified address, and the `passkey` config |
| Input | JSON `{ password, response }`, where `response` is an assertion over the options of [`POST /passkey/authenticate/options`](/docs/reference/routes/#post-passkey-authenticate-options) by a passkey of the user |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`passkey_failed`](/docs/reference/errors/#passkey_failed), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-second-factor-passkey-options"><code>POST /second-factor/passkey/options</code></h3>

| Field | Value |
| --- | --- |
| Needs | A live challenge that offers `passkey`, and the `passkey` config |
| Input | JSON `{ challenge }` |
| Answer | WebAuthn request options with the user's passkeys in `allowCredentials`, bound to this challenge |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-second-factor-disable"><code>POST /second-factor/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON `{ method, password }`, where `method` is `passkey` or `email` |
| Answer | `{ ok: true, methods }`, the methods left. With none left, the factor is off and the trust cookie is cleared. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-email-enable"><code>POST /second-factor/email/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ password }` |
| Answer | `{ methods, backupCodes }`. The codes come once, with the first method; else the list is empty. The first method ends every other session. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-second-factor-email-send"><code>POST /second-factor/email/send</code></h3>

| Field | Value |
| --- | --- |
| Needs | A live challenge of a password sign-in that offers `email` |
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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`breach_check_unavailable`](/docs/reference/errors/#breach_check_unavailable), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found), [`sign_up_closed`](/docs/reference/errors/#sign_up_closed) |

## Handoff

These routes exist when the config sets `handoff`.

<h3 id="get-handoff-start"><code>GET /handoff/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?challenge=&redirect=` |
| Answer | 200, the sign-in page, or 302 to the confirm page when the browser has a session |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-handoff-continue"><code>GET /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session for the confirm page |
| Input | `?h=` |
| Answer | 200, the confirm page, or the sign-in page without a session |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-handoff-continue"><code>POST /handoff/continue</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; `Origin` equal to `baseURL` |
| Input | A form `h` |
| Answer | 302 to `<redirect>?code=` |
| Errors | [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-handoff-redeem"><code>POST /handoff/redeem</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ code, verifier }` |
| Answer | `{ token, user, session }` as a bearer answer, with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

## Organizations

These routes exist when the config sets `organizations`. A write that runs an organization hook also answers the hook codes. The Errors row of each route names its codes.

<h3 id="post-organizations-create"><code>POST /organizations/create</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ slug, name, metadata? }` |
| Answer | `{ organization, member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`organization_limit`](/docs/reference/errors/#organization_limit), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="get-organizations"><code>GET /organizations</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | None |
| Answer | `{ organizations: [{ organization, role }] }` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-organizations-update"><code>POST /organizations/update</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin`, `owner` for a slug |
| Input | JSON `{ organizationId, name?, slug?, metadata? }` |
| Answer | `{ organization }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`slug_taken`](/docs/reference/errors/#slug_taken), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-delete"><code>POST /organizations/delete</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `owner` |
| Input | JSON `{ organizationId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`slug_reserved`](/docs/reference/errors/#slug_reserved), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="get-organizations-members"><code>GET /organizations/members</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `viewer` |
| Input | `?organizationId=` |
| Answer | `{ members }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-organizations-members-add"><code>POST /organizations/members/add</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin` |
| Input | JSON `{ organizationId, userId, role }` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-members-role"><code>POST /organizations/members/role</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin` |
| Input | JSON `{ organizationId, userId, role }` |
| Answer | `{ member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-members-remove"><code>POST /organizations/members/remove</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin`, or the member |
| Input | JSON `{ organizationId, userId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`last_owner`](/docs/reference/errors/#last_owner), [`conflict`](/docs/reference/errors/#conflict), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-invite"><code>POST /organizations/invite</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin` |
| Input | JSON `{ organizationId, email, role }` |
| Answer | `{ invitation }`, with no token |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`invitation_limit`](/docs/reference/errors/#invitation_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="get-organizations-invitations"><code>GET /organizations/invitations</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin` |
| Input | `?organizationId=` |
| Answer | `{ invitations }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-organizations-invitations-revoke"><code>POST /organizations/invitations/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; rank `admin` |
| Input | JSON `{ organizationId, invitationId }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`email_unverified`](/docs/reference/errors/#email_unverified), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-organizations-invitations-accept"><code>POST /organizations/invitations/accept</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and the invited, verified address |
| Input | JSON `{ token }` |
| Answer | `{ organization, member }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`email_mismatch`](/docs/reference/errors/#email_mismatch), [`email_unverified`](/docs/reference/errors/#email_unverified), [`already_member`](/docs/reference/errors/#already_member), [`member_limit`](/docs/reference/errors/#member_limit), [`rate_limited`](/docs/reference/errors/#rate_limited), [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-organizations-invitations-decline"><code>POST /organizations/invitations/decline</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing: the token is the credential |
| Input | JSON `{ token }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired) |

<h3 id="post-organizations-active"><code>POST /organizations/active</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; a membership |
| Input | JSON `{ organizationId }`, a string or `null` |
| Answer | `{ user, session }` with `session.activeOrganizationId` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`forbidden_rank`](/docs/reference/errors/#forbidden_rank), [`unauthorized`](/docs/reference/errors/#unauthorized) |

## API tokens

These routes exist in every deployment.

<h3 id="post-tokens"><code>POST /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address; a token answers 401 |
| Input | JSON `{ name, expiresInDays?, organizationId? }` |
| Answer | `{ token, apiToken }`; the clear token appears once |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`not_found`](/docs/reference/errors/#not_found), [`token_limit`](/docs/reference/errors/#token_limit), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="get-tokens"><code>GET /tokens</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | None |
| Answer | `{ tokens: [{ id, name, hint, expiresAt, lastUsedAt, organizationId, createdAt }] }`, newest first |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified) |

<h3 id="post-tokens-revoke"><code>POST /tokens/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ id }` |
| Answer | `{ ok: true }` |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="get-tokens-current"><code>GET /tokens/current</code></h3>

| Field | Value |
| --- | --- |
| Needs | A `tk_` bearer token only |
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
| Needs | A session; a `tk_` bearer or a JWT bearer answers 401 |
| Input | None |
| Answer | `{ token }`, a session JWT |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`hook_failed`](/docs/reference/errors/#hook_failed) |

<h3 id="post-token-live"><code>POST /token/live</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session JWT of this instance as the bearer; a session token, an API token, an access token, and a cookie answer 401 |
| Input | None |
| Answer | `{ live: true }` while the session of the JWT's `sid` claim exists and is not expired, else `{ live: false }`; it counts on `token-live:session:<sessionId>`, 120 per minute ([Limits](/docs/reference/limits/)) |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Operator

This route exists when the config sets `operator`.

<h3 id="post-operator-keys-rotate"><code>POST /operator/keys/rotate</code></h3>

| Field | Value |
| --- | --- |
| Needs | `Authorization: Operator <secret>`, the secret whose SHA-256 is `operator.secretHash`. The secret must be 32 to 512 visible ASCII characters, and any other secret answers 401 with no reason. |
| Input | None |
| Answer | `{ kid }`, the id of the new signing key. The old key verifies for 24 hours and signs nothing |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## OAuth provider

These routes exist when the config sets `oauth`. They answer the codes of the OAuth table, except where a code of the core table is named.

<h3 id="post-oauth-register"><code>POST /oauth/register</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing; `registration.dynamic` |
| Input | JSON client metadata of RFC 7591 |
| Answer | 201 `{ client_id, client_id_issued_at, client_name?, redirect_uris, token_endpoint_auth_method, grant_types, response_types }` |
| Errors | [`invalid_redirect_uri`](/docs/reference/errors/#oauth-invalid_redirect_uri), [`invalid_client_metadata`](/docs/reference/errors/#oauth-invalid_client_metadata), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-authorize"><code>GET /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session, or a sign-in on the way |
| Input | The OAuth 2.1 parameters with PKCE S256, `resource`, `scope`, `state`, `nonce`, and `prompt`; or `?request_id=` alone |
| Answer | 302 to `/oauth/sign-in`; 200, the consent page; or 302 to the client with `code`, `state`, and `iss` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_response_type`](/docs/reference/errors/#oauth-unsupported_response_type), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`login_required`](/docs/reference/errors/#oauth-login_required), [`consent_required`](/docs/reference/errors/#oauth-consent_required), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-authorize"><code>POST /oauth/authorize</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session of the user that the held request names; `Origin` equal to `baseURL` |
| Input | A form `request_id` and `decision` (`allow` or `deny`) |
| Answer | 302 to the client with `code`, or with `error=access_denied` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted), [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`access_denied`](/docs/reference/errors/#oauth-access_denied), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-sign-in"><code>GET /oauth/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?next=<basePath>/oauth/authorize?…` |
| Answer | 200, the sign-in page, which lands back on `next`; another `next` redirects to `/?auth_error=invalid_request` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request) |

<h3 id="post-oauth-token"><code>POST /oauth/token</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing. A browser on a foreign origin needs that origin in a redirect URI of the client that the form names. Its answer then carries `access-control-allow-origin` and no credentials. An origin of `trustedOrigins` gets that header with credentials. `POST /oauth/revoke` still answers 403 to a cross-site form post. A preflight from that origin names the client in `?client_id=` |
| Input | A form: `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `resource?`; or `grant_type=refresh_token` with `refresh_token`, `client_id`, `scope?`, `resource?` |
| Answer | `{ access_token, token_type: "Bearer", expires_in, scope, refresh_token?, id_token? }` |
| Errors | [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted), [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_grant`](/docs/reference/errors/#oauth-invalid_grant), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_grant_type`](/docs/reference/errors/#oauth-unsupported_grant_type), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="post-oauth-revoke"><code>POST /oauth/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form `token` and `client_id?` (RFC 7009) |
| Answer | 200 `{}` for any token; a refresh token's family goes |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`unauthorized_client`](/docs/reference/errors/#oauth-unauthorized_client), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

<h3 id="get-oauth-userinfo"><code>GET /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token with `openid` |
| Input | None |
| Answer | `{ sub, email?, email_verified?, name?, picture? }` by scope |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope) |

<h3 id="post-oauth-userinfo"><code>POST /oauth/userinfo</code></h3>

| Field | Value |
| --- | --- |
| Needs | An access token with `openid` |
| Input | None |
| Answer | The same as the GET |
| Errors | [`invalid_token`](/docs/reference/errors/#oauth-invalid_token), [`insufficient_scope`](/docs/reference/errors/#oauth-insufficient_scope) |

<h3 id="get-oauth-grants"><code>GET /oauth/grants</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; a token answers 401 |
| Input | None |
| Answer | `{ grants }`: `clientId`, `clientName`, `scopes`, `createdAt`, `refreshTokens` |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized) |

<h3 id="post-oauth-grants-revoke"><code>POST /oauth/grants/revoke</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session; a token answers 401 |
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

## Next

- [Error codes](/docs/reference/errors/)
- [The client package](/docs/reference/client/)
- [Limits](/docs/reference/limits/)
