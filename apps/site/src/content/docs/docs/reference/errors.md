---
title: Error codes
description: Every error code of core, of the OAuth provider, and of the storage port. Each code has its meaning, what the caller does, and the HTTP status of a route code.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 10
  - packages/core/src/errors.ts
  - packages/core/src/http/body-cap.ts
  - packages/core/src/storage/port.ts
  - packages/core/README.md "Organizations"
  - packages/core/src/http/impersonation-rules.ts
  - docs/superpowers/plans/2026-10-14-12h-observability.md
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 4"
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 5"
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
| [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /passkeys/rename`](/docs/reference/routes/#post-passkeys-rename), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify/resend`](/docs/reference/routes/#post-password-verify-resend), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`GET /handoff/start`](/docs/reference/routes/#get-handoff-start), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`POST /tokens/update`](/docs/reference/routes/#post-tokens-update), [`POST /oauth/grants/revoke`](/docs/reference/routes/#post-oauth-grants-revoke), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`GET /social/:provider/start`](/docs/reference/routes/#get-social-provider-start), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`GET /username/available`](/docs/reference/routes/#get-username-available), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

<h3 id="invalid_token"><code>invalid_token</code> 400</h3>

- **Meaning:** A link, a challenge, an invitation, a state, or a code is spent, unknown, or malformed.
- **Do:** Start the flow again. For a link, ask for a new link.

| Routes |
| --- |
| [`GET /magic-link/verify`](/docs/reference/routes/#get-magic-link-verify), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkey/sign-up/verify`](/docs/reference/routes/#post-passkey-sign-up-verify), [`GET /password/verify`](/docs/reference/routes/#get-password-verify), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`GET /password/reset`](/docs/reference/routes/#get-password-reset), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`GET /totp/challenge`](/docs/reference/routes/#get-totp-challenge), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`GET /handoff/continue`](/docs/reference/routes/#get-handoff-continue), [`POST /handoff/continue`](/docs/reference/routes/#post-handoff-continue), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`GET /user/change-email/confirm`](/docs/reference/routes/#get-user-change-email-confirm), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`GET /user/delete/confirm`](/docs/reference/routes/#get-user-delete-confirm), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`GET /user/invite/confirm`](/docs/reference/routes/#get-user-invite-confirm), [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

<h3 id="token_expired"><code>token_expired</code> 400</h3>

- **Meaning:** A link, a code, a state, or a challenge is past its life.
- **Do:** Ask for a new link or start the flow again.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkey/sign-up/verify`](/docs/reference/routes/#post-passkey-sign-up-verify), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`GET /handoff/continue`](/docs/reference/routes/#get-handoff-continue), [`POST /handoff/continue`](/docs/reference/routes/#post-handoff-continue), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/invitations/decline`](/docs/reference/routes/#post-organizations-invitations-decline), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm). |

<h3 id="oauth_denied"><code>oauth_denied</code> 400</h3>

- **Meaning:** The provider sent an error, or the person refused at the provider.
- **Do:** Offer the sign-in again.

| Routes |
| --- |
| [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback). |

<h3 id="oauth_failed"><code>oauth_failed</code> 400</h3>

- **Meaning:** The code exchange, the `tokenRequest` hook, the ID token, the user info call, or the discovery read failed or took over 10 seconds.
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

- **Meaning:** An unknown passkey, a bad signature, or a passkey that is already registered. At a passkey sign-up, the device holds a passkey of an account already.
- **Do:** Offer another method. At a registration, the device may hold a passkey of the account already.

| Routes |
| --- |
| [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkey/sign-up/verify`](/docs/reference/routes/#post-passkey-sign-up-verify), [`POST /reauth`](/docs/reference/routes/#post-reauth). |

<h3 id="passkey_unknown"><code>passkey_unknown</code> 400</h3>

- **Meaning:** The sign-in assertion names a credential that this site does not store. The passkey was deleted, or it belongs to another site.
- **Do:** Call `PublicKeyCredential.signalUnknownCredential` with `rpId` and the credential id, so the device can remove the passkey. Then offer another method.

| Routes |
| --- |
| [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify). |

<h3 id="username_taken"><code>username_taken</code> 409</h3>

- **Meaning:** Another account holds this username. Two names that differ only in case are the same name.
- **Do:** Ask the person for another name. `GET /username/available` checks a name before the form is sent.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

<h3 id="username_invalid"><code>username_invalid</code> 400</h3>

- **Meaning:** The name breaks a rule. It has a character that is not a letter, a digit, the underscore, or the dot. Or its length is outside the bounds of `username`, or the name is reserved.
- **Do:** Show the rule to the person and ask for another name.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`GET /username/available`](/docs/reference/routes/#get-username-available), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

<h3 id="email_unverified"><code>email_unverified</code> 403</h3>

- **Meaning:** The flow needs a verified address, and the user has none.
- **Do:** Send a magic link or the verify mail, so that the person proves the address.

| Routes |
| --- |
| [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/teams/create`](/docs/reference/routes/#post-organizations-teams-create), [`POST /organizations/teams/update`](/docs/reference/routes/#post-organizations-teams-update), [`POST /organizations/teams/delete`](/docs/reference/routes/#post-organizations-teams-delete), [`POST /organizations/teams/members/add`](/docs/reference/routes/#post-organizations-teams-members-add), [`POST /organizations/teams/members/remove`](/docs/reference/routes/#post-organizations-teams-members-remove), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`GET /tokens`](/docs/reference/routes/#get-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`POST /tokens/update`](/docs/reference/routes/#post-tokens-update), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

<h3 id="unauthorized"><code>unauthorized</code> 401</h3>

- **Meaning:** The request has no session, or a credential of the wrong kind for the route.
- **Do:** Sign the person in. A script uses a route that takes an API token.

| Routes |
| --- |
| [`GET /session`](/docs/reference/routes/#get-session), [`POST /session/refresh`](/docs/reference/routes/#post-session-refresh), [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`GET /passkeys`](/docs/reference/routes/#get-passkeys), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /passkeys/rename`](/docs/reference/routes/#post-passkeys-rename), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`GET /totp`](/docs/reference/routes/#get-totp), [`POST /totp/devices/revoke`](/docs/reference/routes/#post-totp-devices-revoke), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`GET /organizations`](/docs/reference/routes/#get-organizations), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`GET /tokens`](/docs/reference/routes/#get-tokens), [`POST /tokens/revoke`](/docs/reference/routes/#post-tokens-revoke), [`POST /tokens/update`](/docs/reference/routes/#post-tokens-update), [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current), [`GET /token`](/docs/reference/routes/#get-token), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`POST /oauth/device`](/docs/reference/routes/#post-oauth-device), [`GET /oauth/grants`](/docs/reference/routes/#get-oauth-grants), [`POST /oauth/grants/revoke`](/docs/reference/routes/#post-oauth-grants-revoke), [`GET /sessions`](/docs/reference/routes/#get-sessions), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /reauth/email`](/docs/reference/routes/#post-reauth-email), [`POST /reauth/passkey/options`](/docs/reference/routes/#post-reauth-passkey-options), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`GET /identities`](/docs/reference/routes/#get-identities), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

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
| [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`GET /social/:provider/start`](/docs/reference/routes/#get-social-provider-start), [`POST /passkey/authenticate/options`](/docs/reference/routes/#post-passkey-authenticate-options), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /passkeys/rename`](/docs/reference/routes/#post-passkeys-rename), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify/resend`](/docs/reference/routes/#post-password-verify-resend), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`GET /handoff/start`](/docs/reference/routes/#get-handoff-start), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/check-slug`](/docs/reference/routes/#post-organizations-check-slug), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current), [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /reauth/email`](/docs/reference/routes/#post-reauth-email), [`POST /reauth/passkey/options`](/docs/reference/routes/#post-reauth-passkey-options), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`GET /username/available`](/docs/reference/routes/#get-username-available), [`POST /user/username`](/docs/reference/routes/#post-user-username), [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

<h3 id="email_taken_unverified"><code>email_taken_unverified</code> 409</h3>

- **Meaning:** An unverified account holds the address, and this flow did not prove it.
- **Do:** Offer a magic link or an email code. Either proves the address and claims the account.

| Routes |
| --- |
| [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up). |

<h3 id="forbidden_rank"><code>forbidden_rank</code> 403</h3>

- **Meaning:** The caller is not a member of the organization, or the rank is too low. On `POST /tokens`, the token's set is wider than the user's set in the organization.
- **Do:** Ask a member of a higher rank.

| Routes |
| --- |
| [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`GET /organizations/members`](/docs/reference/routes/#get-organizations-members), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`GET /organizations/invitations`](/docs/reference/routes/#get-organizations-invitations), [`POST /organizations/invitations/revoke`](/docs/reference/routes/#post-organizations-invitations-revoke), [`POST /organizations/active`](/docs/reference/routes/#post-organizations-active), [`POST /tokens`](/docs/reference/routes/#post-tokens). |

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

- **Meaning:** The user is already a member of the organization, or of the team.
- **Do:** Change the member's role instead. For a team, no change is needed.

| Routes |
| --- |
| [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/teams/members/add`](/docs/reference/routes/#post-organizations-teams-members-add). |

<h3 id="email_mismatch"><code>email_mismatch</code> 403</h3>

- **Meaning:** The invitation is for another address. Or, at the callback of a link, the provider address differs from the account's address, or the provider did not verify it.
- **Do:** Sign in with the invited address. For a link, use the provider account of the account's address, and have the provider verify it.

| Routes |
| --- |
| [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept). The callback of [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link): [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). |

<h3 id="conflict"><code>conflict</code> 409</h3>

- **Meaning:** A write at the same time changed the organization, the member, the stored role, the team, the setup, the account, or the token.
- **Do:** Read the row again, and retry.

| Routes |
| --- |
| [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/roles/update`](/docs/reference/routes/#post-organizations-roles-update), [`POST /organizations/teams/delete`](/docs/reference/routes/#post-organizations-teams-delete), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /tokens/update`](/docs/reference/routes/#post-tokens-update), [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current). The sign-in routes answer it when an account delete commits during the request. So do the organization create, the member add, the team member add, the accept, and the password reset, [`POST /user/username`](/docs/reference/routes/#post-user-username), and [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

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
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /passkey/sign-up/options`](/docs/reference/routes/#post-passkey-sign-up-options), [`POST /passkey/sign-up/verify`](/docs/reference/routes/#post-passkey-sign-up-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). The social callbacks redirect with `?auth_error=sign_up_closed`. |

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

- **Meaning:** A verified account, or an account with a password, holds the address. At a change of address: any account holds the new address. At an operator create: any account holds the address.
- **Do:** Offer the sign-in, or a reset. An operator finds the account with `GET /operator/users/search`.

| Routes |
| --- |
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create). |

<h3 id="token_limit"><code>token_limit</code> 409</h3>

- **Meaning:** The user holds 50 API tokens.
- **Do:** Revoke a token first.

| Routes |
| --- |
| [`POST /tokens`](/docs/reference/routes/#post-tokens). |

<h3 id="token_exhausted"><code>token_exhausted</code> 429</h3>

- **Meaning:** The API token has no calls left in its quota. A refused call spends nothing.
- **Do:** Wait for the refill of the token, or use another token. The app sets the quota in process.

| Routes |
| --- |
| [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current), and each route that resolves the token through `auth.authenticate`. |

<h3 id="token_retired"><code>token_retired</code> 401</h3>

- **Meaning:** The key has a prefix of `tokens.movedPrefixes` and no row, or its row is retired. The key never acts.
- **Do:** Make a new token in the app, and replace the old key.

| Routes |
| --- |
| [`GET /tokens/current`](/docs/reference/routes/#get-tokens-current), and each route that resolves the token through `auth.authenticate`. |

<h3 id="organization_token_limit"><code>organization_token_limit</code> 409</h3>

- **Meaning:** The organization holds 50 live organization tokens.
- **Do:** Revoke a token of the organization first.

| Routes |
| --- |
| [`POST /organizations/tokens`](/docs/reference/routes/#post-organizations-tokens). |

<h3 id="hook_refused"><code>hook_refused</code> 403</h3>

- **Meaning:** A before hook of the app threw `hookRefusal(message)`. The body carries `message`.
- **Do:** Show `message` to the person.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/teams/create`](/docs/reference/routes/#post-organizations-teams-create), [`POST /organizations/teams/update`](/docs/reference/routes/#post-organizations-teams-update), [`POST /organizations/teams/delete`](/docs/reference/routes/#post-organizations-teams-delete), [`POST /organizations/teams/members/add`](/docs/reference/routes/#post-organizations-teams-members-add), [`POST /organizations/teams/members/remove`](/docs/reference/routes/#post-organizations-teams-members-remove), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /user/username`](/docs/reference/routes/#post-user-username), [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

<h3 id="hook_failed"><code>hook_failed</code> 500</h3>

- **Meaning:** A before hook threw another error, a session patch was wrong, or `jwtMint.claims` failed.
- **Do:** Read the log line of the hook, and fix the hook.

| Routes |
| --- |
| [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/update`](/docs/reference/routes/#post-organizations-update), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /organizations/members/add`](/docs/reference/routes/#post-organizations-members-add), [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), [`POST /organizations/members/remove`](/docs/reference/routes/#post-organizations-members-remove), [`POST /organizations/invite`](/docs/reference/routes/#post-organizations-invite), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /organizations/teams/create`](/docs/reference/routes/#post-organizations-teams-create), [`POST /organizations/teams/update`](/docs/reference/routes/#post-organizations-teams-update), [`POST /organizations/teams/delete`](/docs/reference/routes/#post-organizations-teams-delete), [`POST /organizations/teams/members/add`](/docs/reference/routes/#post-organizations-teams-members-add), [`POST /organizations/teams/members/remove`](/docs/reference/routes/#post-organizations-teams-members-remove), [`GET /token`](/docs/reference/routes/#get-token), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email/confirm`](/docs/reference/routes/#post-user-change-email-confirm), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /user/username`](/docs/reference/routes/#post-user-username), [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

<h3 id="internal"><code>internal</code> 500</h3>

- **Meaning:** A route had an unhandled error. The server wrote one log line with the route.
- **Do:** Read the log line, and report the error. Try the request again later.

| Routes |
| --- |
| Every route. |

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
| [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/reset/request`](/docs/reference/routes/#post-password-reset-request), [`POST /magic-link/request`](/docs/reference/routes/#post-magic-link-request), [`POST /otp/request`](/docs/reference/routes/#post-otp-request), [`POST /otp/reset/request`](/docs/reference/routes/#post-otp-reset-request), [`POST /phone/request`](/docs/reference/routes/#post-phone-request), [`POST /anonymous/sign-in`](/docs/reference/routes/#post-anonymous-sign-in), [`POST /passkey/sign-up/options`](/docs/reference/routes/#post-passkey-sign-up-options), each when `captcha.flows` names its flow. |

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

<h3 id="phone_invalid"><code>phone_invalid</code> 400</h3>

- **Meaning:** The phone number is not in E.164 form. That form is a plus sign and 8 to 15 digits, with no leading zero.
- **Do:** Ask for the number again with the plus sign and the country code, and with no space.

| Routes |
| --- |
| [`POST /phone/request`](/docs/reference/routes/#post-phone-request), [`POST /phone/add`](/docs/reference/routes/#post-phone-add), [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create). |

<h3 id="phone_region"><code>phone_region</code> 400</h3>

- **Meaning:** The number is outside every prefix of `phone.regions`. No SMS was sent.
- **Do:** Tell the person that this app sends no code to numbers of that country, and offer another method.

| Routes |
| --- |
| [`POST /phone/request`](/docs/reference/routes/#post-phone-request), [`POST /phone/add`](/docs/reference/routes/#post-phone-add), [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create). |

<h3 id="sms_unavailable"><code>sms_unavailable</code> 503</h3>

- **Meaning:** The SMS port of the app answered `"unavailable"` or threw. The code counted against `phone.dailyCap`. Only `api.phone.request` and `api.phone.add` in process answer it. `POST /phone/request` and `POST /phone/add` send after the answer, and an outage gives an `sms.not_sent` line.
- **Do:** Try again later, or offer another method.

| Routes |
| --- |
| None. |

<h3 id="phone_taken"><code>phone_taken</code> 409</h3>

- **Meaning:** Another account set this phone number first. The unique key of the number decided a race. The code of this request stays live.
- **Do:** Tell the person that another account has the number. To move the number, that account must remove it first. At an operator create, an account holds the number, and nothing was written.

| Routes |
| --- |
| [`POST /phone/add/verify`](/docs/reference/routes/#post-phone-add-verify), [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create). |

<h3 id="host_not_allowed"><code>host_not_allowed</code> 421</h3>

- **Meaning:** `baseURL` is a list, and the origin of the request is not one of its entries. The scheme, the host, and the port must each be equal. No handler ran. Core reads no `x-forwarded-host` or `forwarded` header.
- **Do:** Add the origin to the `baseURL` list, or send the request to an origin of the list. Behind a proxy on Node, build `request.url` from the host that the proxy checked.

| Routes |
| --- |
| Every route, and `auth.wellKnown`, while `baseURL` is a list. See [the base URL list](/docs/guides/base-url-list/). |

<h3 id="body_too_large"><code>body_too_large</code> 413</h3>

- **Meaning:** The request body is longer than the cap of its route. Core stopped the read at the cap, so no handler parsed the body. A false or absent `content-length` does not change the count. The cap is 65536 bytes, 262144 bytes for `POST /social/apple/callback`, and 8388608 bytes for the two SSO connection writes. The router answers it for every route that reads a body.
- **Do:** Send a smaller body. Each cap is the next power of two above the largest valid body of its route. A client that gets this code sends a wrong body.

| Routes |
| --- |
| Every route with a body, except the SCIM routes, which answer their own SCIM 413 past 1 MB. See [Limits](/docs/reference/limits/). |

<h3 id="body_busy"><code>body_busy</code> 503</h3>

- **Meaning:** The body reads of the routes with a cap above 65536 bytes hold at most 16777216 bytes in this isolate, in two halves. Now the reads of signed-in users hold their half, 8388608 bytes, or the other reads hold theirs, 8388608 bytes. Or the reads of one client hold its share: 4194304 bytes for an IP, or the cap of the read for a user. A client is its IP before a session and its user after one. Core stopped the read, so no handler parsed the body. The answer carries `Retry-After: 1`.
- **Do:** Send the request again after the seconds of `Retry-After`. A burst of large bodies at once gets this code. A body at the floor of 65536 bytes never gets it.

| Routes |
| --- |
| `POST /social/apple/callback`, `POST /sso/connections/create`, `POST /sso/connections/update`, and `POST /sso/:connectionId/acs`. The SCIM routes answer their own SCIM 503. See [Limits](/docs/reference/limits/). |

<h3 id="body_timeout"><code>body_timeout</code> 408</h3>

- **Meaning:** A body read of a route with a cap above the floor stopped at a deadline. It got no bytes for 10 s, or it ran past the time of its cap at 131072 bytes per second. That time is at least 10 s. Core freed the bytes of the read, so no handler parsed the body.
- **Do:** Send the whole body again, with no pause. A link slower than 128 KiB per second can get this code for a large body. A body at the floor never gets it.

| Routes |
| --- |
| `POST /social/apple/callback`, `POST /sso/connections/create`, `POST /sso/connections/update`, `POST /sso/:connectionId/acs`, and each SCIM route that takes a body. See [Limits](/docs/reference/limits/). |

<h3 id="anonymous_refused"><code>anonymous_refused</code> 403</h3>

- **Meaning:** An anonymous session called a route that needs a way in, or that would change the anonymous user in place. At `POST /anonymous/delete`, a session that is not anonymous called it. The route did nothing.
- **Do:** Ask the person to sign in or to create an account first. The sign-in replaces the anonymous user. To delete an anonymous user, call `POST /anonymous/delete`.

| Routes |
| --- |
| [`POST /reauth`](/docs/reference/routes/#post-reauth), [`POST /reauth/passkey/options`](/docs/reference/routes/#post-reauth-passkey-options), [`POST /reauth/email`](/docs/reference/routes/#post-reauth-email), [`POST /user/update`](/docs/reference/routes/#post-user-update), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /user/change-email/verify`](/docs/reference/routes/#post-user-change-email-verify), [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /user/username`](/docs/reference/routes/#post-user-username), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkey/register/verify`](/docs/reference/routes/#post-passkey-register-verify), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /totp/setup`](/docs/reference/routes/#post-totp-setup), [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /second-factor/passkey/enable`](/docs/reference/routes/#post-second-factor-passkey-enable), [`POST /second-factor/passkey/options`](/docs/reference/routes/#post-second-factor-passkey-options), [`POST /second-factor/email/enable`](/docs/reference/routes/#post-second-factor-email-enable), [`POST /phone/add`](/docs/reference/routes/#post-phone-add), [`POST /phone/add/verify`](/docs/reference/routes/#post-phone-add-verify), [`POST /anonymous/delete`](/docs/reference/routes/#post-anonymous-delete), [`POST /organizations/create`](/docs/reference/routes/#post-organizations-create), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept), [`POST /tokens`](/docs/reference/routes/#post-tokens), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`POST /oauth/device`](/docs/reference/routes/#post-oauth-device). |

<h3 id="session_not_fresh"><code>session_not_fresh</code> 403</h3>

- **Meaning:** The change needs a session that a sign-in or a re-authentication proved within `session.freshMinutes`.
- **Do:** Re-authenticate at `POST /reauth`, then send the change again. The session token stays the same.

| Routes |
| --- |
| [`POST /reauth`](/docs/reference/routes/#post-reauth) makes the session fresh. The account routes [`POST /sessions/revoke`](/docs/reference/routes/#post-sessions-revoke), [`POST /sessions/revoke-others`](/docs/reference/routes/#post-sessions-revoke-others), [`POST /user/change-email`](/docs/reference/routes/#post-user-change-email), [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /social/:provider/link`](/docs/reference/routes/#post-social-provider-link), and [`POST /user/delete`](/docs/reference/routes/#post-user-delete) need a fresh session. So do the passkey and token routes [`POST /passkey/register/options`](/docs/reference/routes/#post-passkey-register-options), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /tokens`](/docs/reference/routes/#post-tokens), and [`POST /tokens/update`](/docs/reference/routes/#post-tokens-update). So do the factor routes [`POST /totp/enable`](/docs/reference/routes/#post-totp-enable), [`POST /totp/disable`](/docs/reference/routes/#post-totp-disable), [`POST /totp/backup-codes`](/docs/reference/routes/#post-totp-backup-codes), [`POST /second-factor/passkey/enable`](/docs/reference/routes/#post-second-factor-passkey-enable), [`POST /second-factor/email/enable`](/docs/reference/routes/#post-second-factor-email-enable), and [`POST /second-factor/disable`](/docs/reference/routes/#post-second-factor-disable). [`POST /password/change`](/docs/reference/routes/#post-password-change) needs one for a first password, and while the second factor is on. An owner needs one at each SSO manager route, such as [`POST /sso/connections/create`](/docs/reference/routes/#post-sso-connections-create) and [`POST /sso/domains/add`](/docs/reference/routes/#post-sso-domains-add), [`POST /user/username`](/docs/reference/routes/#post-user-username). |

<h3 id="last_credential"><code>last_credential</code> 409</h3>

- **Meaning:** The removal would leave the account with no way to sign in. A password counts only while a sign-in reaches it. That is by an address, by a username while `username` is on, or by a phone that signs in.
- **Do:** Add another way in first: a passkey, a provider, a verified address, a phone, or a password with one of those identifiers. Then remove this one.

| Routes |
| --- |
| [`POST /identities/unlink`](/docs/reference/routes/#post-identities-unlink), [`POST /passkeys/delete`](/docs/reference/routes/#post-passkeys-delete), [`POST /phone/remove`](/docs/reference/routes/#post-phone-remove). |

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
| [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), and the operator delete [`POST /operator/users/delete`](/docs/reference/routes/#post-operator-users-delete). |

<h3 id="delete_too_large"><code>delete_too_large</code> 409</h3>

- **Meaning:** The delete does not fit one request, so it changes nothing. An account delete answers it when the account is the only member of more than 50 organizations. An organization delete answers it when the organization has more than 500 SCIM Groups. The operator delete of an account answers it for the same count of organizations, on every store. D1 allows 50 queries per invocation on Workers Free. There the self delete and the operator delete also answer it when their least work cannot fit that budget (plan 12f2). The solo organizations cost 6 calls for any count. Each organization that the user owns with another owner costs 3 calls, and a plain membership costs none. So on D1 a secret with the scope `delete` takes 1 solo organization and at most 3 such organizations. A platform operator has the smallest budget: 1 solo organization and none of them, or no solo organization and at most 2. The self delete of a person with 1 to 50 solo organizations takes at most 2 such organizations, and so does the mailed confirm. With no solo organization, each takes at most 4. A store tells such a limit with `queryLimitPerInvocation`; Postgres, MySQL, SQLite, and memory have none.
- **Do:** For an account, delete those organizations with [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete) first. For an organization, let the directory delete some groups first. For a self delete or an operator delete on D1, let the user leave each organization that the user owns with another owner. Or delete the account with a secret that holds the scope `delete`. Then send the delete again.

| Routes |
| --- |
| [`POST /user/delete`](/docs/reference/routes/#post-user-delete), [`POST /user/delete/confirm`](/docs/reference/routes/#post-user-delete-confirm), [`POST /organizations/delete`](/docs/reference/routes/#post-organizations-delete), [`POST /operator/users/delete`](/docs/reference/routes/#post-operator-users-delete), and `auth.api.operator.users.delete`. |

<h3 id="account_banned"><code>account_banned</code> 403</h3>

- **Meaning:** An operator banned the account. Only a person who proved the credential gets this code.
- **Do:** Tell the person to contact support. Do not try again.

| Routes |
| --- |
| The sign-in routes answer it after the credential check: [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback). A race with the ban can reach it at [`POST /handoff/redeem`](/docs/reference/routes/#post-handoff-redeem), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge). The operator tools [`POST /operator/users/platform-role`](/docs/reference/routes/#post-operator-users-platform-role) and [`POST /operator/users/create-admin`](/docs/reference/routes/#post-operator-users-create-admin) refuse a banned target. [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm) answers it after the token check. |

<h3 id="operator_required"><code>operator_required</code> 403</h3>

- **Meaning:** The caller is not an operator for this action. The operator secret has no scope for the route, or the session fails the operator user guard. The code does not tell which step failed.
- **Do:** Use a secret with the scope of the route. A platform operator verifies the address, turns a second factor on, and re-authenticates.

| Routes |
| --- |
| [`POST /operator/keys/rotate`](/docs/reference/routes/#post-operator-keys-rotate) needs the scope `keys`. [`GET /operator/secrets/status`](/docs/reference/routes/#get-operator-secrets-status) and [`POST /operator/secrets/rewrap`](/docs/reference/routes/#post-operator-secrets-rewrap) need the scope `secrets`. The operator user tools need the scope `users`, `sessions`, or `audit`, or a platform operator who passes the guard. These routes are [`GET /operator/users`](/docs/reference/routes/#get-operator-users), [`GET /operator/users/search`](/docs/reference/routes/#get-operator-users-search), [`GET /operator/users/get`](/docs/reference/routes/#get-operator-users-get), [`POST /operator/users/ban`](/docs/reference/routes/#post-operator-users-ban), [`POST /operator/users/unban`](/docs/reference/routes/#post-operator-users-unban), [`POST /operator/users/platform-role`](/docs/reference/routes/#post-operator-users-platform-role), [`POST /operator/users/second-factor/disable`](/docs/reference/routes/#post-operator-users-second-factor-disable), [`POST /operator/users/create`](/docs/reference/routes/#post-operator-users-create), [`POST /operator/users/update`](/docs/reference/routes/#post-operator-users-update), [`POST /operator/sessions/end-user`](/docs/reference/routes/#post-operator-sessions-end-user), [`POST /operator/sessions/end-all`](/docs/reference/routes/#post-operator-sessions-end-all), and [`GET /operator/audit`](/docs/reference/routes/#get-operator-audit). [`POST /operator/users/delete`](/docs/reference/routes/#post-operator-users-delete) needs the scope `delete`. [`POST /operator/users/create-admin`](/docs/reference/routes/#post-operator-users-create-admin) takes a secret only. |

<h3 id="operator_self"><code>operator_self</code> 409</h3>

- **Meaning:** A platform operator tried to act on their own account. An act on another platform operator answers `operator_required`.
- **Do:** Ask another operator, or use an operator secret.

| Routes |
| --- |
| [`POST /operator/users/ban`](/docs/reference/routes/#post-operator-users-ban), [`POST /operator/users/unban`](/docs/reference/routes/#post-operator-users-unban), [`POST /operator/users/platform-role`](/docs/reference/routes/#post-operator-users-platform-role), [`POST /operator/users/second-factor/disable`](/docs/reference/routes/#post-operator-users-second-factor-disable), [`POST /operator/users/update`](/docs/reference/routes/#post-operator-users-update), [`POST /operator/users/delete`](/docs/reference/routes/#post-operator-users-delete), and [`POST /operator/sessions/end-user`](/docs/reference/routes/#post-operator-sessions-end-user), for a platform operator who names their own user. |

<h3 id="impersonation_refused"><code>impersonation_refused</code> 403</h3>

- **Meaning:** The target of an impersonation is the operator, a platform operator, banned, or absent. One code answers each case.
- **Do:** Check the user id. An operator cannot impersonate a platform operator.

| Routes |
| --- |
| [`POST /operator/impersonate`](/docs/reference/routes/#post-operator-impersonate). |

<h3 id="impersonation_session"><code>impersonation_session</code> 403</h3>

- **Meaning:** An impersonation session cannot reach this route. The router answers it before the handler, so the route changes nothing.
- **Do:** Stop the impersonation with [`POST /operator/impersonate/stop`](/docs/reference/routes/#post-operator-impersonate-stop), and do the action from the operator's own session, or ask the user to do it.

| Routes |
| --- |
| The Errors cell of each route on the [routes page](/docs/reference/routes/) names it. It covers the sign-out, the re-authentication, and every operator route but the stop. It covers each change of a way in, the second-factor routes, and the handoff. It covers the organization writes that give or take a role, and the OAuth authorize, consent, and end-session routes. The in-process calls of the same acts answer it too. It also covers the stored role writes and the token writes of plan 12k. Their in-process calls do not answer it: such a call is the app's own act. |

<h3 id="domain_unverified"><code>domain_unverified</code> 400</h3>

- **Meaning:** A resolver of `sso.dns` did not give the value of the TXT record. Every resolver must give it. A resolver that answers nothing in 10 seconds counts as a refusal.
- **Do:** Publish the record of the add answer at `_authtempo-challenge.<domain>`, wait for the DNS to show it, then send the verify again.

| Routes |
| --- |
| [`POST /sso/domains/verify`](/docs/reference/routes/#post-sso-domains-verify). |

<h3 id="domain_taken"><code>domain_taken</code> 409</h3>

- **Meaning:** Another organization holds the verified domain. One domain belongs to one organization.
- **Do:** Ask the other organization to delete its domain, then send the verify again.

| Routes |
| --- |
| [`POST /sso/domains/verify`](/docs/reference/routes/#post-sso-domains-verify). |

<h3 id="domain_limit"><code>domain_limit</code> 409</h3>

- **Meaning:** The organization holds `sso.limits.domainsPerOrganization` domains, pending and verified, 20 by default.
- **Do:** Delete a domain that the organization does not use, or raise the limit in the config.

| Routes |
| --- |
| [`POST /sso/domains/add`](/docs/reference/routes/#post-sso-domains-add). |

<h3 id="connection_limit"><code>connection_limit</code> 409</h3>

- **Meaning:** The organization holds `sso.limits.connectionsPerOrganization` SSO connections, 10 by default.
- **Do:** Delete a connection that the organization does not use, or raise the limit in the config.

| Routes |
| --- |
| [`POST /sso/connections/create`](/docs/reference/routes/#post-sso-connections-create). |

<h3 id="second_factor_required"><code>second_factor_required</code> 403</h3>

- **Meaning:** The owner of the organization has no second factor. An owner manages the SSO setup only with a second factor on.
- **Do:** Turn on a second factor, such as TOTP at `POST /totp/enable`, then send the request again with a fresh session.

| Routes |
| --- |
| The SSO manager routes of an owner: [`GET /sso/domains`](/docs/reference/routes/#get-sso-domains), [`POST /sso/domains/add`](/docs/reference/routes/#post-sso-domains-add), [`POST /sso/domains/verify`](/docs/reference/routes/#post-sso-domains-verify), [`POST /sso/domains/update`](/docs/reference/routes/#post-sso-domains-update), [`POST /sso/domains/delete`](/docs/reference/routes/#post-sso-domains-delete), [`GET /sso/connections`](/docs/reference/routes/#get-sso-connections), [`POST /sso/connections/create`](/docs/reference/routes/#post-sso-connections-create), [`POST /sso/connections/update`](/docs/reference/routes/#post-sso-connections-update), and [`POST /sso/connections/delete`](/docs/reference/routes/#post-sso-connections-delete). |

<h3 id="sso_failed"><code>sso_failed</code> 400</h3>

- **Meaning:** An SSO sign-in failed at one step. For OIDC, the step is the state, the binding cookie, the discovery document, the code exchange, the ID token, or the nonce. For SAML, the step is a check of the Response, such as `wrapping`, `signature`, `audience`, or `replay`. The log line `authtempo: sso failed` names the connection id and the step.
- **Do:** Start the sign-in again. If it fails again, check the issuer, the client id, and the client secret of the connection.

| Routes |
| --- |
| [`GET /sso/:connectionId/start`](/docs/reference/routes/#get-sso-connectionid-start), [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback), and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="sso_not_configured"><code>sso_not_configured</code> 404</h3>

- **Meaning:** No enabled connection can sign in the person. The connection does not exist, it is off, or its kind is off. The discovery found no connection for the address.
- **Do:** Sign in another way, or ask the organization owner to route the domain to an enabled connection.

| Routes |
| --- |
| [`POST /sso/discover`](/docs/reference/routes/#post-sso-discover) as a form post, [`GET /sso/:connectionId/start`](/docs/reference/routes/#get-sso-connectionid-start), [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback), and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="sso_required"><code>sso_required</code> 403</h3>

- **Meaning:** The address is in a verified domain whose owner turned `enforce` on, so only SSO signs it in. The body holds `detail`, the SSO start URL: an absolute URL on the origin of `baseURL`. A social callback carries the code in the `auth_error` query parameter of the redirect.
- **Do:** Send the person to `detail` to sign in through the organization's provider. The magic link, email code, and reset requests of such an address send no mail and answer as usual. A phone code request for the number of such an account sends no SMS and answers as usual. A link, a code, or a second factor challenge from before `enforce` went on opens no session either. An operator create of such an address writes no invitation link, mails nothing, and answers `mailed: null`.

| Routes |
| --- |
| [`POST /password/sign-in`](/docs/reference/routes/#post-password-sign-in), [`POST /password/sign-up`](/docs/reference/routes/#post-password-sign-up), [`POST /password/change`](/docs/reference/routes/#post-password-change), [`POST /magic-link/verify`](/docs/reference/routes/#post-magic-link-verify), [`POST /otp/verify`](/docs/reference/routes/#post-otp-verify), [`GET /social/:provider/callback`](/docs/reference/routes/#get-social-provider-callback), [`POST /social/apple/callback`](/docs/reference/routes/#post-social-apple-callback), and [`POST /passkey/authenticate/verify`](/docs/reference/routes/#post-passkey-authenticate-verify), [`POST /password/verify`](/docs/reference/routes/#post-password-verify), [`POST /password/reset`](/docs/reference/routes/#post-password-reset), [`POST /otp/reset`](/docs/reference/routes/#post-otp-reset), [`POST /totp/verify`](/docs/reference/routes/#post-totp-verify), [`POST /totp/challenge`](/docs/reference/routes/#post-totp-challenge), [`POST /social/:provider/id-token`](/docs/reference/routes/#post-social-provider-id-token), [`POST /password/verify/code`](/docs/reference/routes/#post-password-verify-code), [`POST /phone/verify`](/docs/reference/routes/#post-phone-verify), and [`POST /user/invite/confirm`](/docs/reference/routes/#post-user-invite-confirm). |

<h3 id="sso_domain_mismatch"><code>sso_domain_mismatch</code> 403</h3>

- **Meaning:** The provider of the connection gave an address that no verified domain of the connection's organization claims. Or the identity of the sign-in names a user whose current address no such domain claims. Core never reads the `email_verified` of the provider: only the organization's DNS proof makes an address true.
- **Do:** Ask the organization owner to verify the domain of the address, or to fix the address at the provider. A user who moved the account address out of the domain signs in another way.

| Routes |
| --- |
| [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback) and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="sso_not_provisioned"><code>sso_not_provisioned</code> 403</h3>

- **Meaning:** The connection has `jit` off, and no user has the address. The sign-in creates no user.
- **Do:** Ask the organization to create the account first, for example through its directory.

| Routes |
| --- |
| [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback) and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="account_disabled"><code>account_disabled</code> 403</h3>

- **Meaning:** The organization's directory turned the user off through SCIM, so the SSO sign-in of that organization refuses the user.
- **Do:** Ask the organization to turn the account on again in its directory.

| Routes |
| --- |
| [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback) and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="role_not_found"><code>role_not_found</code> 409</h3>

- **Meaning:** The connection gives new members a role that the organization no longer has, so the sign-in adds no member row and writes nothing.
- **Do:** Ask the organization owner to set the connection's `defaultRole` to a role that exists.

| Routes |
| --- |
| [`GET /sso/:connectionId/callback`](/docs/reference/routes/#get-sso-connectionid-callback) and [`POST /sso/:connectionId/acs`](/docs/reference/routes/#post-sso-connectionid-acs), in the `auth_error` query parameter of the redirect. |

<h3 id="role_in_use"><code>role_in_use</code> 409</h3>

- **Meaning:** A member of the organization or a pending invitation holds the role name, alone or as a part of its role string. A delete of the role, or a create of a role with that name, answers this code.
- **Do:** Give each member another role with [`POST /organizations/members/role`](/docs/reference/routes/#post-organizations-members-role), revoke the invitations, then send the request again.

| Routes |
| --- |
| [`POST /organizations/roles/create`](/docs/reference/routes/#post-organizations-roles-create), [`POST /organizations/roles/delete`](/docs/reference/routes/#post-organizations-roles-delete). |

<h3 id="role_limit"><code>role_limit</code> 409</h3>

- **Meaning:** The organization holds `organizations.dynamicRoles.maxPerOrganization` stored roles, 50 by default.
- **Do:** Delete a role that no member holds, or raise the limit in the config.

| Routes |
| --- |
| [`POST /organizations/roles/create`](/docs/reference/routes/#post-organizations-roles-create). |

<h3 id="role_taken"><code>role_taken</code> 409</h3>

- **Meaning:** The organization holds a stored role with this name.
- **Do:** Choose another name, or change the role with [`POST /organizations/roles/update`](/docs/reference/routes/#post-organizations-roles-update).

| Routes |
| --- |
| [`POST /organizations/roles/create`](/docs/reference/routes/#post-organizations-roles-create). |

<h3 id="team_limit"><code>team_limit</code> 409</h3>

- **Meaning:** The organization holds `organizations.limits.teamsPerOrganization` teams.
- **Do:** Delete a team, or raise the limit in the config.

| Routes |
| --- |
| [`POST /organizations/teams/create`](/docs/reference/routes/#post-organizations-teams-create). |

<h3 id="team_member_limit"><code>team_member_limit</code> 409</h3>

- **Meaning:** The team holds `organizations.limits.membersPerTeam` members. At an accept, the invitation stays pending, and the person joins nothing.
- **Do:** Remove a member from the team, or raise the limit in the config. Then add the person or accept again.

| Routes |
| --- |
| [`POST /organizations/teams/members/add`](/docs/reference/routes/#post-organizations-teams-members-add), [`POST /organizations/invitations/accept`](/docs/reference/routes/#post-organizations-invitations-accept). |

<h3 id="last_team"><code>last_team</code> 409</h3>

- **Meaning:** The team is the last team of the organization, and `organizations.teams.keepLastTeam` is on.
- **Do:** Create another team first, then delete this one.

| Routes |
| --- |
| [`POST /organizations/teams/delete`](/docs/reference/routes/#post-organizations-teams-delete). |

<h3 id="not_ready"><code>not_ready</code> 503</h3>

- **Meaning:** The store gave no answer to the readiness check. The body also carries `reason`. It is `storage` when the store threw or gave no answer in 3 seconds. It is `schema` when the stored schema version is older than the adapter. It names no host, no database, no version, and no error name.
- **Do:** For `schema`, run the migrations of your adapter. For `storage`, check the database and its binding. The route keeps one result for 10 seconds, so call it again after that time.

| Routes |
| --- |
| [`GET /ready`](/docs/reference/routes/#get-ready), when the config sets `observe.readiness: true`. |

## OAuth codes

`OAUTH_ERRORS` of `@authtempo/core` holds these codes. The provider routes answer them, because an OAuth client reads these strings. `invalid_token` and `rate_limited` are in both tables, so an OAuth anchor has the prefix `oauth-`.

<h3 id="oauth-invalid_request"><code>invalid_request</code> 400</h3>

- **Meaning:** A parameter is missing, repeated, or wrong, or the held request is unknown, spent, or older than 10 minutes.
- **Do:** Fix the request, or start the authorize step again.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`GET /oauth/sign-in`](/docs/reference/routes/#get-oauth-sign-in), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke), [`POST /oauth/introspect`](/docs/reference/routes/#post-oauth-introspect), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization), [`POST /oauth/device`](/docs/reference/routes/#post-oauth-device). |

<h3 id="oauth-invalid_client"><code>invalid_client</code> 400 or 401</h3>

- **Meaning:** The `client_id` is unknown, or its metadata document failed. At the token, revoke, introspection, and device authorization routes, the client auth failed. At the introspection route, the caller is also not a confidential client with `introspect: true`. The secret is wrong, or a confidential client sent no secret, or a public client sent one. A `private_key_jwt` client sent a secret, or its client assertion failed a check of RFC 7523. At those routes a request with an `Authorization` header gets the 401 with `WWW-Authenticate: Basic` and the issuer as the realm. A request with no header gets a 400 with no challenge, so a browser shows no sign-in dialog.
- **Do:** Register the client again, or fix its metadata document. Send the secret as HTTP Basic or as `client_secret` in the form, and send one method only.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke), [`POST /oauth/introspect`](/docs/reference/routes/#post-oauth-introspect), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization). |

<h3 id="oauth-invalid_grant"><code>invalid_grant</code> 400</h3>

- **Meaning:** The code or the refresh token is spent, expired, of another client, or its verifier does not match. A refresh token whose grant keeps no scope of the config but `offline_access` is refused too. A code with no challenge takes no verifier. A reused refresh token deletes its family. A device code is spent, of another client, or unknown.
- **Do:** Start the authorize step again.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-unsupported_grant_type"><code>unsupported_grant_type</code> 400</h3>

- **Meaning:** The `grant_type` is not `authorization_code`, `refresh_token`, `client_credentials`, or, with `oauth.device` on, the device grant `urn:ietf:params:oauth:grant-type:device_code`.
- **Do:** Use a grant type that the server serves.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-invalid_scope"><code>invalid_scope</code> 400</h3>

- **Meaning:** A scope is unknown, the list is empty, or a refresh asks for more than the grant. A `client_credentials` request asks for a scope that is not in both the client's `credentialsScopes` and `oauth.scopes`, or no such scope is left.
- **Do:** Ask for known scopes only.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization). |

<h3 id="oauth-invalid_target"><code>invalid_target</code> 400</h3>

- **Meaning:** The `resource` is not one of `oauth.resources`, or not the grant's resource. An authorize request, a `client_credentials` request, or a device start has no `resource` while `oauth.defaultResource` is not set. An empty `resource` counts as none.
- **Do:** Send the resource of the grant.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization). |

<h3 id="oauth-unsupported_response_type"><code>unsupported_response_type</code> 400</h3>

- **Meaning:** The `response_type` is not `code`.
- **Do:** Send `response_type=code`.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-access_denied"><code>access_denied</code> 400</h3>

- **Meaning:** The person refused, or the user has no verified address. At the token route, the person denied the device code (RFC 8628 section 3.5).
- **Do:** Show that access was refused. A device stops its poll.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-login_required"><code>login_required</code> 400</h3>

- **Meaning:** `prompt=none`, and the person must sign in: no session, or a sign-in older than `max_age`.
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

<h3 id="oauth-request_not_supported"><code>request_not_supported</code> 400</h3>

- **Meaning:** The authorize request has a `request` parameter. Core takes no request object (OIDC Core 3.1.2.6).
- **Do:** Send the parameters in the query.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-request_uri_not_supported"><code>request_uri_not_supported</code> 400</h3>

- **Meaning:** The authorize request has a `request_uri` parameter. Core takes no request URI (OIDC Core 3.1.2.6).
- **Do:** Send the parameters in the query.

| Routes |
| --- |
| [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize). |

<h3 id="oauth-registration_not_supported"><code>registration_not_supported</code> 400</h3>

- **Meaning:** The authorize request has a `registration` parameter. Core takes no client data in the request (OIDC Core 3.1.2.6).
- **Do:** Register the client first, then send its `client_id`.

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

- **Meaning:** The registration metadata is malformed, or names an auth method, a grant type, or a response type that core does not serve. A pairwise client has no single sector, or a key field breaks its rule. `api.oauth.clients` answers this code for the same fields.
- **Do:** Fix the field. A metadata document drops a member that core does not serve, so only a broken rule refuses it.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register). |

<h3 id="oauth-invalid_token"><code>invalid_token</code> 401</h3>

- **Meaning:** The bearer of the userinfo route is not a live access token of this instance, or it is a DPoP-bound token. Under the `DPoP` scheme, the token is not bound. At the register route, the bearer is not the initial access token.
- **Do:** Refresh the access token. Send a bound token as `Authorization: DPoP` with a new proof. At the register route, send the initial access token that the app gave you.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register), [`GET /oauth/userinfo`](/docs/reference/routes/#get-oauth-userinfo), [`POST /oauth/userinfo`](/docs/reference/routes/#post-oauth-userinfo). |

<h3 id="oauth-insufficient_scope"><code>insufficient_scope</code> 403</h3>

- **Meaning:** The access token of the userinfo route has no `openid` scope.
- **Do:** Ask for `openid` at the authorize step.

| Routes |
| --- |
| [`GET /oauth/userinfo`](/docs/reference/routes/#get-oauth-userinfo), [`POST /oauth/userinfo`](/docs/reference/routes/#post-oauth-userinfo). |

<h3 id="oauth-invalid_dpop_proof"><code>invalid_dpop_proof</code> 400</h3>

- **Meaning:** The `DPoP` header of a token request fails a check of RFC 9449 section 4.3, or its `jti` was spent. Or a client of `dpop_bound_access_tokens` sent no proof. Or the code, the refresh token, or the device code is bound to another key. At userinfo, a bound token came with no valid proof of its key. The status there is 401, with the `DPoP` challenge (RFC 9449 section 7.1).
- **Do:** Sign a new proof for each request, with `htm`, `htu`, a fresh `iat`, and a new `jti`. Use the key that the code or the refresh token is bound to.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization), [`GET /oauth/userinfo`](/docs/reference/routes/#get-oauth-userinfo), [`POST /oauth/userinfo`](/docs/reference/routes/#post-oauth-userinfo). |

<h3 id="oauth-authorization_pending"><code>authorization_pending</code> 400</h3>

- **Meaning:** The person has not yet approved or denied the device code (RFC 8628 section 3.5).
- **Do:** Poll again after `interval` seconds.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-slow_down"><code>slow_down</code> 400</h3>

- **Meaning:** The device polled within `interval` seconds of its last poll. The interval of the code grows by 5 seconds (RFC 8628 section 3.5).
- **Do:** Add 5 seconds to the interval, for this poll and every later one.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-expired_token"><code>expired_token</code> 400</h3>

- **Meaning:** The device code expired, and its device authorization ended (RFC 8628 section 3.5).
- **Do:** Stop the poll. Start a new device authorization when the person asks for it.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token). |

<h3 id="oauth-rate_limited"><code>rate_limited</code> 429</h3>

- **Meaning:** A limit of the provider is full: register, authorize, or token for the IP, or introspection for the IP or the client. Or a device limit is full: the device request for the IP, or the device page for the session, the IP, or one code. A `GET /oauth/device` with no session counts as an authorize request.
- **Do:** Wait for the window to end.

| Routes |
| --- |
| [`POST /oauth/register`](/docs/reference/routes/#post-oauth-register), [`GET /oauth/authorize`](/docs/reference/routes/#get-oauth-authorize), [`POST /oauth/authorize`](/docs/reference/routes/#post-oauth-authorize), [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke), [`POST /oauth/introspect`](/docs/reference/routes/#post-oauth-introspect), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization), [`GET /oauth/device`](/docs/reference/routes/#get-oauth-device), [`POST /oauth/device`](/docs/reference/routes/#post-oauth-device). |

<h3 id="oauth-unauthorized_client"><code>unauthorized_client</code> 400</h3>

- **Meaning:** A revoke named a `client_id` that is not the client of the refresh token. Nothing is revoked. Or a `client_credentials` request came from a public client, or from a client whose `grantTypes` do not hold the grant. A device request or poll came from a client without the device grant, or from a pairwise client. An authorize request or a code exchange came from a client whose `grantTypes` lack `authorization_code`. A refresh came from a client whose `grantTypes` lack `refresh_token`.
- **Do:** Revoke with the client id of the token, or with no client id. For `client_credentials`, use a confidential client of `api.oauth.clients` with the grant. For another grant, add it to the client's `grantTypes`.

| Routes |
| --- |
| [`POST /oauth/token`](/docs/reference/routes/#post-oauth-token), [`POST /oauth/revoke`](/docs/reference/routes/#post-oauth-revoke), [`POST /oauth/device_authorization`](/docs/reference/routes/#post-oauth-device-authorization). |

## Storage codes

`STORAGE_ERROR_CODES` of `@authtempo/core/errors` holds these codes. A storage adapter throws `StorageError` with one of them. No route answers a storage code. A storage error that no handler catches answers 500 [`internal`](#internal).

<h3 id="unique_violation"><code>unique_violation</code></h3>

- **Meaning:** A unique key refused a write, because a row with the same key exists.
- **Do:** In an adapter, throw it for each unique key of the schema. The engine reads it as a lost race.

<h3 id="unknown_model"><code>unknown_model</code></h3>

- **Meaning:** A call names a model that `schema` of `@authtempo/core` does not have.
- **Do:** Use a model name of `schema`.

<h3 id="unknown_field"><code>unknown_field</code></h3>

- **Meaning:** A call names a field that the model does not have.
- **Do:** Use a field name of the model in `schema`.

<h3 id="invalid_argument"><code>invalid_argument</code></h3>

- **Meaning:** The port refuses a value or a clause. Examples are an empty `where` on `update` or `delete`, and a NUL or a lone surrogate in a `where` value.
- **Meaning on MySQL:** A string is longer than its column, or a value on an ascii column is not printable ASCII. [Length bounds](/docs/guides/mysql/#length-bounds) lists each column.
- **Do:** Fix the call. [Write a storage adapter](/docs/guides/adapter/#the-rules) lists the rules of the port.

<h3 id="schema_mismatch"><code>schema_mismatch</code></h3>

- **Meaning:** The `schema_version` in `ta_meta` is older than `SCHEMA_VERSION` of core, or the database has no `ta_meta`. Every operation throws it until the migrations run.
- **Do:** Run the migrations of the adapter, or [authtempo migrate](/docs/reference/cli/migrate/). Then the next operation reads the version again.

<h3 id="rollback_failed"><code>rollback_failed</code></h3>

- **Meaning:** A D1 or SQLite rollback could not undo every write of the transaction. Its `cause` holds `{ original, failures }`.
- **Do:** Read `cause`. Check the rows that the transaction wrote, because some of them stay.

<h3 id="config_mismatch"><code>config_mismatch</code></h3>

- **Meaning:** The database or the driver handle has a setting that breaks the rules of the port. The message names the setting, never a value.
- **Do:** Change the setting. [SQLite](/docs/guides/sqlite/#settings-the-adapter-refuses) lists the driver settings, and [MySQL](/docs/guides/mysql/#the-checks-at-start) lists the server settings.

## Other answers

- The router answers 500 `{ "error": "internal" }` for an error that no handler caught. It writes the log line `authtempo: unhandled error <method> <path> <error name>`.
- The client package adds `network`, `unexpected`, and `cancelled`. [The client package](/docs/reference/client/) tells when each appears.
- The handoff package adds `redirect_mismatch`. [The handoff package](/docs/reference/handoff/) tells when it appears.

## Next

- [Routes](/docs/reference/routes/)
- [The client package](/docs/reference/client/)
- [Versioning policy](/docs/versioning/)
