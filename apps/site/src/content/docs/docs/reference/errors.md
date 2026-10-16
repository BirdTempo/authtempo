---
title: Error codes
description: Every error code of core and of the OAuth provider, with its HTTP status, its meaning, and what the caller does.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 10
  - packages/core/src/errors.ts
  - packages/core/README.md "Organizations"
---

**For:** a developer who reads an error answer of authtempo and must act on it.

**What it does:** this page gives one anchor for each code: the status, the meaning, and what the caller does.

## Before you start

- Know which route answered. [Routes](/docs/reference/routes/) lists the codes of each route.

## The answer

A failure answers JSON `{ "error": "<code>" }` with the status of the code. Only `hook_refused` adds `message`. A redirect flow sends the browser to `/?auth_error=<code>` on `appURL` instead. A new code is a minor version.

## Core codes

`ERRORS` of `@authtempo/core` holds these codes. The client package reads the same table.

<h3 id="invalid_body"><code>invalid_body</code> 400</h3>

- **Meaning:** The body, the query, or one of its fields is missing, malformed, or of the wrong type.
- **Do:** Fix the request. For a form, show the person the field to correct.

| Routes |
| --- |
| [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify/resend`](/docs/reference/routes/#post-password-verify-resend), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`GET /handoff/start`](/docs/reference/routes/#get-handoff-start), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`POST /oauth/grants/revoke`](/docs/reference/routes/#post-oauth-grants-revoke), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

<h3 id="invalid_token"><code>invalid_token</code> 400</h3>

- **Meaning:** A link, a challenge, an invitation, a state, or a code is spent, unknown, or malformed.
- **Do:** Start the flow again. For a link, ask for a new link.

| Routes |
| --- |
| [`GET /magic-link/verify`](/docs/reference/routes/#get-magic-link-verify), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`GET /password/verify`](/docs/reference/routes/#get-password-verify), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`GET /password/reset`](/docs/reference/routes/#get-password-reset), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`GET /totp/challenge`](/docs/reference/routes/#get-totp-challenge), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`GET /handoff/continue`](/docs/reference/routes/#get-handoff-continue), [`POST /handoff/continue`](/docs/reference/routes/#post-handoff-continue), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`GET /user/change-email/confirm`](/docs/reference/routes/#get-user-change-email-confirm), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm). |

<h3 id="token_expired"><code>token_expired</code> 400</h3>

- **Meaning:** A link, a code, a state, or a challenge is past its life.
- **Do:** Ask for a new link or start the flow again.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`GET /handoff/continue`](/docs/reference/routes/#get-handoff-continue), [`POST /handoff/continue`](/docs/reference/routes/#post-handoff-continue), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm). |

<h3 id="oauth_denied"><code>oauth_denied</code> 400</h3>

- **Meaning:** The provider sent an error, or the person refused at the provider.
- **Do:** Offer the sign-in again.

| Routes |
| --- |
| [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). |

<h3 id="oauth_failed"><code>oauth_failed</code> 400</h3>

- **Meaning:** The code exchange, the ID token, the user info call, or the discovery read failed, or took more than 10 seconds.
- **Do:** Check the client id, the secret, and the redirect URI at the provider. Then retry.

| Routes |
| --- |
| [`GET /social/:provider/start`](/docs/reference/routes/#get-social-provider-start), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link). |

<h3 id="email_required"><code>email_required</code> 400</h3>

- **Meaning:** The profile of the provider has no address.
- **Do:** Offer another method, or ask the person to share the address with the app at the provider.

| Routes |
| --- |
| [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). |

<h3 id="passkey_failed"><code>passkey_failed</code> 400</h3>

- **Meaning:** An unknown passkey, a bad signature, or a passkey that is already registered.
- **Do:** Offer another method. At a registration, the device may hold a passkey of the account already.

| Routes |
| --- |
| [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /reauth`](/docs/reference/routes/#post-reauth). |

<h3 id="email_unverified"><code>email_unverified</code> 403</h3>

- **Meaning:** The flow needs a verified address, and the user has none.
- **Do:** Send a magic link or the verify mail, so that the person proves the address.

| Routes |
| --- |
| [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`GET /tokens`](/docs/reference/routes/#get-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link). |

<h3 id="unauthorized"><code>unauthorized</code> 401</h3>

- **Meaning:** The request has no session, or a credential of the wrong kind for the route.
- **Do:** Sign the person in. A script uses a route that takes an API token.

| Routes |
| --- |
| [`GET /session`](/docs/reference/routes/#get-session), [`POST /session/refresh`](/docs/reference/routes/#post-session-refresh), [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`GET /passkeys`](/docs/reference/routes/#get-passkeys), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`GET /totp`](/docs/reference/routes/#get-totp), [`POST /totp/devices/revoke`](/docs/reference/routes/#post-totp-devices-revoke), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`GET /organizations`](/docs/reference/routes/#get-organizations), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`GET /tokens`](/docs/reference/routes/#get-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current), [`GET /token`](/docs/reference/routes/#get-token), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`GET /oauth/grants`](/docs/reference/routes/#get-oauth-grants), [`POST /oauth/grants/revoke`](/docs/reference/routes/#post-oauth-grants-revoke), [`GET /sessions`](/docs/reference/routes/#get-sessions), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /reauth/email`](/docs/reference/routes/#post-reauth-email), [`POST /reauth/passkey/options`](/docs/reference/routes/#post-reauth-passkey-options), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`GET /identities`](/docs/reference/routes/#get-identities), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

<h3 id="origin_not_trusted"><code>origin_not_trusted</code> 403</h3>

- **Meaning:** The `Origin` header is not `baseURL` and not in `trustedOrigins`. Or the request is a form post that the browser marks as not same-origin.
- **Do:** Add the origin of the app to `trustedOrigins`. Post JSON, or post the form from `baseURL`.

| Routes |
| --- |
| Every POST route. |

<h3 id="not_found"><code>not_found</code> 404</h3>

- **Meaning:** No such route, a feature that the config turns off, or a row that does not belong to the caller. A route that opens a session also answers it when a `session.beforeCreate` patch names an organization that the user is not a member of.
- **Do:** Check the config, the path, and the id.

| Routes |
| --- |
| Every route of a feature that the config turns off, the routes that read a row by id, and the routes that open a session. |

<h3 id="rate_limited"><code>rate_limited</code> 429</h3>

- **Meaning:** A limit of the flow is full for the key: the address, the IP, or the user.
- **Do:** Wait for the window to end. [Limits](/docs/reference/limits/) lists each window.

| Routes |
| --- |
| [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`GET /social/:provider/start`](/docs/reference/routes/#get-social-provider-start), [`POST /passkey/authenticate/options`](/docs/reference/routes/#post-passkey-authenticate-options), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify/resend`](/docs/reference/routes/#post-password-verify-resend), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`GET /handoff/start`](/docs/reference/routes/#get-handoff-start), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /reauth/email`](/docs/reference/routes/#post-reauth-email), [`POST /reauth/passkey/options`](/docs/reference/routes/#post-reauth-passkey-options), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

<h3 id="email_taken_unverified"><code>email_taken_unverified</code> 409</h3>

- **Meaning:** An unverified account holds the address, and this flow did not prove it.
- **Do:** Offer a magic link or an email code. Either proves the address and claims the account.

| Routes |
| --- |
| [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up). |

<h3 id="forbidden_rank"><code>forbidden_rank</code> 403</h3>

- **Meaning:** The caller is not a member of the organization, or the rank is too low.
- **Do:** Ask a member of a higher rank.

| Routes |
| --- |
| [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active). |

<h3 id="slug_reserved"><code>slug_reserved</code> 400</h3>

- **Meaning:** The slug is on the reserved list, or the organization is the platform organization.
- **Do:** Pick another slug.

| Routes |
| --- |
| [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete). |

<h3 id="slug_taken"><code>slug_taken</code> 409</h3>

- **Meaning:** Another organization holds the slug.
- **Do:** Pick another slug.

| Routes |
| --- |
| [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update). |

<h3 id="last_owner"><code>last_owner</code> 409</h3>

- **Meaning:** The write would leave the organization with no owner.
- **Do:** Make another member an owner first.

| Routes |
| --- |
| [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove). |

<h3 id="already_member"><code>already_member</code> 409</h3>

- **Meaning:** The user is already a member of the organization.
- **Do:** Change the member's role instead.

| Routes |
| --- |
| [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept). |

<h3 id="email_mismatch"><code>email_mismatch</code> 403</h3>

- **Meaning:** The invitation is for another address. Or, at the callback of a link, the provider address differs from the account's address, or the provider did not verify it.
- **Do:** Sign in with the invited address. For a link, use the provider account of the account's address, and have the provider verify it.

| Routes |
| --- |
| [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept). The callback of [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link): [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). |

<h3 id="conflict"><code>conflict</code> 409</h3>

- **Meaning:** A write at the same time changed the organization, the member, the setup, or the account.
- **Do:** Read the row again, and retry.

| Routes |
| --- |
| [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). The sign-in routes answer it when an account delete commits during the request. So do the organization create, the member add, the accept, and the password reset. |

<h3 id="invalid_credentials"><code>invalid_credentials</code> 401</h3>

- **Meaning:** The address or the password is wrong, or the password row is gone.
- **Do:** Ask the person to try again, or offer a reset.

| Routes |
| --- |
| [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /reauth`](/docs/reference/routes/#post-reauth). |

<h3 id="sign_up_closed"><code>sign_up_closed</code> 403</h3>

- **Meaning:** `signUp` is `false`, or it is `"invited"` and the address has no pending invitation. No user was created.
- **Do:** Tell the person that this app takes no new accounts, or that an invitation is needed.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). The social callbacks redirect with `?auth_error=sign_up_closed`. |

<h3 id="password_policy"><code>password_policy</code> 400</h3>

- **Meaning:** The password is too short, too long, holds a control character, or equals the address.
- **Do:** Show the policy, and ask for another password.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset). |

<h3 id="password_breached"><code>password_breached</code> 400</h3>

- **Meaning:** `password.breachCheck` answered true for the password.
- **Do:** Ask for another password.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset). |

<h3 id="breach_check_unavailable"><code>breach_check_unavailable</code> 503</h3>

- **Meaning:** `password.breachCheck` answered `"unavailable"`, so core refused the password. The check fails closed.
- **Do:** Try again in a few minutes. A reset link stays usable. A reset code is spent, so ask for a new code.

| Routes |
| --- |
| The routes of [`password_breached`](#password_breached). |

<h3 id="email_taken"><code>email_taken</code> 409</h3>

- **Meaning:** A verified account, or an account with a password, holds the address. At a change of address: any account holds the new address.
- **Do:** Offer the sign-in, or a reset.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify). |

<h3 id="token_limit"><code>token_limit</code> 409</h3>

- **Meaning:** The user holds 50 API tokens.
- **Do:** Revoke a token first.

| Routes |
| --- |
| [`POST /tokens`](/docs/reference/routes/#post-tokens). |

<h3 id="hook_refused"><code>hook_refused</code> 403</h3>

- **Meaning:** A before hook of the app threw `hookRefusal(message)`. The body carries `message`.
- **Do:** Show `message` to the person.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

<h3 id="hook_failed"><code>hook_failed</code> 500</h3>

- **Meaning:** A before hook threw another error, a session patch was wrong, or `jwtMint.claims` failed.
- **Do:** Read the log line of the hook, and fix the hook.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`GET /token`](/docs/reference/routes/#get-token), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

<h3 id="organization_limit"><code>organization_limit</code> 409</h3>

- **Meaning:** The user holds `organizations.limits.perUser` memberships.
- **Do:** Leave an organization first.

| Routes |
| --- |
| [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create). |

<h3 id="member_limit"><code>member_limit</code> 409</h3>

- **Meaning:** The organization holds `organizations.limits.membersPerOrganization` members. The invitation stays pending.
- **Do:** Remove a member first.

| Routes |
| --- |
| [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept). |

<h3 id="invitation_limit"><code>invitation_limit</code> 409</h3>

- **Meaning:** The organization holds `organizations.limits.pendingInvitationsPerOrganization` pending invitations.
- **Do:** Revoke an invitation first.

| Routes |
| --- |
| [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite). |

<h3 id="invalid_code"><code>invalid_code</code> 400</h3>

- **Meaning:** An email code or a second factor code is wrong, expired, spent, or unknown.
- **Do:** Ask the person to type the code again.

| Routes |
| --- |
| [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify). |

<h3 id="too_many_attempts"><code>too_many_attempts</code> 400</h3>

- **Meaning:** The code or the challenge took its last wrong guess, and core spent it.
- **Do:** Request a new code, or sign in again.

| Routes |
| --- |
| [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify). |

<h3 id="totp_enabled"><code>totp_enabled</code> 409</h3>

- **Meaning:** The second factor is already on for the user.
- **Do:** Turn it off first, then set it up again.

| Routes |
| --- |
| [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable). |

<h3 id="totp_not_enabled"><code>totp_not_enabled</code> 400</h3>

- **Meaning:** The second factor is off, or its setup is older than 15 minutes.
- **Do:** Run the setup again.

| Routes |
| --- |
| [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes). |

<h3 id="second_factor_last_method"><code>second_factor_last_method</code> 409</h3>

- **Meaning:** The passkey is the last passkey of the user, and the passkey is a second-factor method.
- **Do:** Turn the passkey method off first, or register another passkey.

| Routes |
| --- |
| [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete). |

<h3 id="captcha_required"><code>captcha_required</code> 400</h3>

- **Meaning:** The flow has a captcha, and the request has no `x-captcha-response` header.
- **Do:** Show the widget, and send its token in the header.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), each when `captcha.flows` names its flow. |

<h3 id="captcha_failed"><code>captcha_failed</code> 403</h3>

- **Meaning:** The captcha refused the token, or the token is longer than 2048 characters. A token passes once.
- **Do:** Show the widget again, and send its new token.

| Routes |
| --- |
| The routes of [`captcha_required`](#captcha_required). |

<h3 id="captcha_unavailable"><code>captcha_unavailable</code> 503</h3>

- **Meaning:** The captcha gave no answer, and `captcha.onUnavailable` is `"refuse"`.
- **Do:** Try again later.

| Routes |
| --- |
| The routes of [`captcha_required`](#captcha_required). |

<h3 id="session_not_fresh"><code>session_not_fresh</code> 403</h3>

- **Meaning:** The change needs a session that a sign-in or a re-authentication proved within `session.freshMinutes`.
- **Do:** Re-authenticate at `POST /reauth`, then send the change again. The session token stays the same.

| Routes |
| --- |
| [`POST /reauth`](/docs/reference/routes/#post-reauth) makes the session fresh. The account routes [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), and [`POST /user/delete`](/docs/reference/routes/#post-user-delete) need a fresh session. So do the passkey and token routes [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), and [`POST /tokens`](/docs/reference/routes/#post-tokens). So do the factor routes [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /second-factor/passkey/enable`](/docs/reference/routes/#post-second-factor-passkey-enable), [`POST /second-factor/email/enable`](/docs/reference/routes/#post-second-factor-email-enable), and [`POST /second-factor/disable`](/docs/reference/routes/#post-second-factor-disable). [`POST /password/change`](/docs/reference/routes/#post-password-change) needs one for a first password, and while the second factor is on. |

<h3 id="last_credential"><code>last_credential</code> 409</h3>

- **Meaning:** The removal would leave the account with no way to sign in.
- **Do:** Add another way in first: a passkey, a password, a provider, or a verified address. Then remove this one.

| Routes |
| --- |
| [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete). |

<h3 id="identity_taken"><code>identity_taken</code> 409</h3>

- **Meaning:** Another account holds the provider account. Core never moves an identity between accounts.
- **Do:** Sign in to the other account, and unlink the provider there. Then link it here.

| Routes |
| --- |
| The callback of [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link): [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). |

<h3 id="sole_owner"><code>sole_owner</code> 409</h3>

- **Meaning:** The account is the last owner of an organization with other members, or of the platform organization.
- **Do:** Make another member an owner with [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), then delete the account again.

| Routes |
| --- |
| [`POST /user/delete`](/docs/reference/routes/#post-user-delete). |

## OAuth codes

`OAUTH_ERRORS` of `@authtempo/core` holds these codes. The provider routes answer them, because an OAuth client reads these strings. `invalid_token` and `rate_limited` are in both tables, so an OAuth anchor has the prefix `oauth-`.

<h3 id="oauth-invalid_request"><code>invalid_request</code> 400</h3>

- **Meaning:** A parameter is missing, repeated, or wrong, or the held request is unknown, spent, or older than 10 minutes.
- **Do:** Fix the request, or start the authorize step again.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`GET /oauth/sign-in`](/docs/reference/routes/#get-oauth-sign-in), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke). |

<h3 id="oauth-invalid_client"><code>invalid_client</code> 401</h3>

- **Meaning:** The `client_id` is unknown, or its metadata document failed.
- **Do:** Register the client again, or fix its metadata document.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-invalid_grant"><code>invalid_grant</code> 400</h3>

- **Meaning:** The code or the refresh token is spent, expired, of another client, or its verifier does not match. A reused refresh token deletes its family.
- **Do:** Start the authorize step again.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-unsupported_grant_type"><code>unsupported_grant_type</code> 400</h3>

- **Meaning:** The `grant_type` is not `authorization_code` or `refresh_token`.
- **Do:** Use one of the two grant types.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-invalid_scope"><code>invalid_scope</code> 400</h3>

- **Meaning:** A scope is unknown, the list is empty, or a refresh asks for more than the grant.
- **Do:** Ask for known scopes only.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-invalid_target"><code>invalid_target</code> 400</h3>

- **Meaning:** The `resource` is not one of `oauth.resources`, or not the grant's resource.
- **Do:** Send the resource of the grant.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-unsupported_response_type"><code>unsupported_response_type</code> 400</h3>

- **Meaning:** The `response_type` is not `code`.
- **Do:** Send `response_type=code`.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-access_denied"><code>access_denied</code> 400</h3>

- **Meaning:** The person refused, or the user has no verified address.
- **Do:** Show that access was refused.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize). |

<h3 id="oauth-login_required"><code>login_required</code> 400</h3>

- **Meaning:** `prompt=none` with no session, or `prompt=login` with a session.
- **Do:** Send the person through the authorize step with no `prompt`.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-consent_required"><code>consent_required</code> 400</h3>

- **Meaning:** `prompt=none`, and no consent covers the scopes.
- **Do:** Send the person through the authorize step with no `prompt`.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-invalid_redirect_uri"><code>invalid_redirect_uri</code> 400</h3>

- **Meaning:** A redirect URI at registration is not https, a loopback http URL, or a private-use scheme.
- **Do:** Register a redirect URI of an allowed form.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register). |

<h3 id="oauth-invalid_client_metadata"><code>invalid_client_metadata</code> 400</h3>

- **Meaning:** The registration metadata is malformed, or names an auth method, a grant type, or a response type that core does not serve.
- **Do:** Send only the fields of a public client.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register). |

<h3 id="oauth-invalid_token"><code>invalid_token</code> 401</h3>

- **Meaning:** The bearer of the userinfo route is not a live access token of this instance.
- **Do:** Refresh the access token.

| Routes |
| --- |
| [`GET /oauth/userinfo`](/docs/reference/routes/#get-oauth-userinfo), [`POST /oauth/userinfo`](/docs/reference/routes/#post-oauth-userinfo). |

<h3 id="oauth-insufficient_scope"><code>insufficient_scope</code> 403</h3>

- **Meaning:** The access token of the userinfo route has no `openid` scope.
- **Do:** Ask for `openid` at the authorize step.

| Routes |
| --- |
| [`GET /oauth/userinfo`](/docs/reference/routes/#get-oauth-userinfo), [`POST /oauth/userinfo`](/docs/reference/routes/#post-oauth-userinfo). |

<h3 id="oauth-rate_limited"><code>rate_limited</code> 429</h3>

- **Meaning:** A limit of the provider is full: register, authorize, or token for the IP.
- **Do:** Wait for the window to end.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register), [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke). |

<h3 id="oauth-unauthorized_client"><code>unauthorized_client</code> 400</h3>

- **Meaning:** A revoke named a `client_id` that is not the client of the refresh token. Nothing is revoked.
- **Do:** Revoke with the client id of the token, or with no client id.

| Routes |
| --- |
| [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke). |

## Other answers

- The router answers 500 `{ "error": "internal" }` for an error that no handler caught. It writes the log line `authtempo: unhandled error <method> <path> <error name>`.
- The client package adds `network`, `unexpected`, and `cancelled`. [The client package](/docs/reference/client/) tells when each appears.
- The handoff package adds `redirect_mismatch`. [The handoff package](/docs/reference/handoff/) tells when it appears.

## Next

- [Routes](/docs/reference/routes/)
- [The client package](/docs/reference/client/)
- [Versioning policy](/docs/versioning/)
