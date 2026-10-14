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

## Magic link

These routes exist in every deployment.

<h3 id="post-magic-link-request"><code>POST /magic-link/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, next? }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Input | A form or JSON `token` |
| Answer | A form: 302 to `appURL` plus `next`, with the cookie. JSON: `{ user, session }` with the cookie |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

## Social sign-in

These routes exist for each configured provider. `:provider` is the name of the provider, such as `google`, `github`, or a list entry.

<h3 id="get-social-provider-start"><code>GET /social/:provider/start</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?next=` |
| Answer | 302 to the provider, with the binding cookie `tempo_session_oauth`. A failure redirects to `/?auth_error=<code>` |
| Errors | [`rate_limited`](/docs/reference/errors/#rate_limited), [`oauth_failed`](/docs/reference/errors/#oauth_failed) |

<h3 id="get-social-provider-callback"><code>GET /social/:provider/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | The binding cookie |
| Input | `?code&state`, or `?error` from the provider |
| Answer | 302 to `appURL` plus `next`, with the session cookie. A failure redirects to `/?auth_error=<code>` |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-social-apple-callback"><code>POST /social/apple/callback</code></h3>

| Field | Value |
| --- | --- |
| Needs | The binding cookie; the Origin check is skipped |
| Input | A form `code`, `state`, and `user?` from Apple |
| Answer | The same as the GET callback |
| Errors | [`oauth_denied`](/docs/reference/errors/#oauth_denied), [`oauth_failed`](/docs/reference/errors/#oauth_failed), [`email_required`](/docs/reference/errors/#email_required), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`not_found`](/docs/reference/errors/#not_found) |

## Passwords

These routes exist when the config sets `password`.

<h3 id="post-password-sign-up"><code>POST /password/sign-up</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, name? }` |
| Answer | `{ token, user, session }` with the cookie. The address stays unverified until the mailed link |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`email_taken`](/docs/reference/errors/#email_taken), [`email_taken_unverified`](/docs/reference/errors/#email_taken_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-password-sign-in"><code>POST /password/sign-in</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, password, trustDevice?, next? }` |
| Answer | `{ token, user, session }` with the cookie, or `{ twoFactor: { challenge, expiresAt } }` with no cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

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
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Input | A form or JSON `token` and `password` |
| Answer | A form: 302 to `next` with the cookie, or back to the form. JSON: `{ token, user, session }` with the cookie |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token), [`token_expired`](/docs/reference/errors/#token_expired), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-password-change"><code>POST /password/change</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ currentPassword?, newPassword }` |
| Answer | `{ ok: true }`; every other session ends |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## Second factor

These routes exist when the config sets `password` and `totp` is not `false`.

<h3 id="post-totp-setup"><code>POST /totp/setup</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ password }` |
| Answer | `{ secret, uri, backupCodes }`, each answered once |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`invalid_credentials`](/docs/reference/errors/#invalid_credentials), [`email_unverified`](/docs/reference/errors/#email_unverified), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`conflict`](/docs/reference/errors/#conflict), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-enable"><code>POST /totp/enable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session and a verified address |
| Input | JSON `{ code }` |
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices }`; every other session ends |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`totp_enabled`](/docs/reference/errors/#totp_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`email_unverified`](/docs/reference/errors/#email_unverified), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-totp-disable"><code>POST /totp/disable</code></h3>

| Field | Value |
| --- | --- |
| Needs | A session |
| Input | JSON `{ code }`, a current code or a backup code |
| Answer | `{ ok: true }`, and the trust cookie is cleared |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`totp_not_enabled`](/docs/reference/errors/#totp_not_enabled), [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

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
| Answer | `{ enabled, enabledAt, backupCodesLeft, trustedDevices }`; never the secret |
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
| Input | JSON `{ challenge, code }` or `{ challenge, backupCode }`, and `trustDevice?` |
| Answer | `{ token, user, session, next, backupCodesLeft, trustDevice }` with the session cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="get-totp-challenge"><code>GET /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | `?challenge=` |
| Answer | 200, the challenge form; no side effect |
| Errors | [`invalid_token`](/docs/reference/errors/#invalid_token) |

<h3 id="post-totp-challenge"><code>POST /totp/challenge</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | A form `challenge`, `code` or `backupCode`, and `trustDevice=1` |
| Answer | 302 to `next` with the cookies; back to the form on a wrong code |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`invalid_token`](/docs/reference/errors/#invalid_token), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

## Email codes

These routes exist unless the config sets `emailOtp: false`. The two reset routes also need `password`.

<h3 id="post-otp-request"><code>POST /otp/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-otp-verify"><code>POST /otp/verify</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, code }` |
| Answer | `{ token, user, session }` with the cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

<h3 id="post-otp-reset-request"><code>POST /otp/reset/request</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email }` |
| Answer | `{ sent: true }` for every address |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`rate_limited`](/docs/reference/errors/#rate_limited) |

<h3 id="post-otp-reset"><code>POST /otp/reset</code></h3>

| Field | Value |
| --- | --- |
| Needs | Nothing |
| Input | JSON `{ email, code, password }` |
| Answer | `{ token, user, session }` with the cookie |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`invalid_code`](/docs/reference/errors/#invalid_code), [`too_many_attempts`](/docs/reference/errors/#too_many_attempts), [`password_policy`](/docs/reference/errors/#password_policy), [`password_breached`](/docs/reference/errors/#password_breached), [`rate_limited`](/docs/reference/errors/#rate_limited), [`hook_refused`](/docs/reference/errors/#hook_refused), [`hook_failed`](/docs/reference/errors/#hook_failed), [`not_found`](/docs/reference/errors/#not_found) |

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
| Needs | Nothing |
| Input | A form: `grant_type=authorization_code` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `resource?`; or `grant_type=refresh_token` with `refresh_token`, `client_id`, `scope?`, `resource?` |
| Answer | `{ access_token, token_type: "Bearer", expires_in, scope, refresh_token?, id_token? }` |
| Errors | [`invalid_request`](/docs/reference/errors/#oauth-invalid_request), [`invalid_client`](/docs/reference/errors/#oauth-invalid_client), [`invalid_grant`](/docs/reference/errors/#oauth-invalid_grant), [`invalid_scope`](/docs/reference/errors/#oauth-invalid_scope), [`invalid_target`](/docs/reference/errors/#oauth-invalid_target), [`unsupported_grant_type`](/docs/reference/errors/#oauth-unsupported_grant_type), [`rate_limited`](/docs/reference/errors/#oauth-rate_limited) |

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
