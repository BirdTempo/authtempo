---
title: Events
description: Every event of core with its level, its fields and their kinds, and its default line.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 31
  - packages/observe/README.md "What a sink never gets"
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 13"
---

**For:** an operator who reads the events of authtempo in a sink, or a developer who writes a sink.

**What it does:** this page lists each event of core, with its level, its fields and their kinds, and its default line.

## Before you start

- Read [Observability](/docs/operations/observability/). It sets up a sink.

## What an event is

This table is the log inventory of OWASP ASVS 5.0.0 16.1.1. Core emits one event for each authentication act, each limit hit, each sweep, and each fault. `EVENTS` of `@authtempo/core/observe` holds every row, and a site check holds this page to it.

An event is telemetry, and it can drop. A full buffer and a slow sink lose events, and `observe.dropped` counts them. The audit table of the operator tools and `hooks.operator.afterAction` are the record of an operator act. A session row is the record of a sign-in.

Each event has these fields too:

- `name`, `level`, and `at`, a UTC time in ISO 8601 from the clock of the config.
- `traceId` and `spanId`, in lowercase hex. `parentSpanId` comes from a trusted `traceparent` header.
- `route`, the route key of the request, when the event comes from a request.
- `rejected`, the names of the fields that failed their kind. Core drops such a field and keeps the event.
- `ip`, `ipHash`, `userAgent`, and `emailHash`, only when `observe.include` turns them on. An event never holds a raw email.

## The events

### The request and the session

| Event | Level | Fields | When |
| --- | --- | --- | --- |
| `request` | info | `method: method`, `status: status`, `outcome: enum`, `code?: code`, `durationMs: durationMs` | Once for each answer of `handle`. The router stamps the route key, or `unmatched`. |
| `sign_in` | info | `method: enum`, `provider?: name`, `outcome: enum`, `code?: code`, `userId?: id`, `sessionId?: id` | A session opens, a second factor is due, or a route of a sign-in answers a failure code. |
| `sign_up` | info | `method: enum`, `outcome: enum`, `code?: code`, `userId?: id` | A user row is created, by any way in. |
| `sign_out` | info | `sessionId?: id`, `outcome: enum`, `code?: code`, `userId?: id` | A sign-out ends its session. |
| `session.end` | info | `reason: enum`, `count: count` | An act ends sessions. `count` is the count of rows that the deletes answered. |

### The factors and the account

| Event | Level | Fields | When |
| --- | --- | --- | --- |
| `second_factor.challenge` | info | `method?: enum`, `outcome: enum`, `code?: code`, `userId?: id` | A second factor challenge passes, or a wrong proof fails it. |
| `second_factor.enable` | info | `method: enum`, `outcome: enum`, `code?: code`, `userId?: id` | A method of the second factor turns on. |
| `second_factor.disable` | warn | `method?: enum`, `outcome: enum`, `code?: code`, `userId?: id` | A method turns off. With no method, every method turned off. |
| `backup_codes.regenerate` | info | `outcome: enum`, `code?: code`, `userId?: id` | A user makes a new set of backup codes. |
| `passkey.register` | info | `outcome: enum`, `code?: code`, `userId?: id` | A passkey is added to an account. |
| `passkey.delete` | info | `outcome: enum`, `code?: code`, `userId?: id` | A passkey is removed from an account. |
| `password.reset_request` | info | `outcome: enum`, `code?: code` | A reset request is accepted. It holds no user, because the answer is the same for every address. |
| `password.reset` | info | `outcome: enum`, `code?: code`, `userId?: id` | A reset link sets a new password. |
| `password.change` | info | `outcome: enum`, `code?: code`, `userId?: id` | A signed-in user changes the password. |
| `email.verify` | info | `method: enum`, `outcome: enum`, `code?: code`, `userId?: id` | An address is proved. |
| `reauth` | info | `method: enum`, `outcome: enum`, `code?: code`, `userId?: id` | A re-authentication passes or fails. |

### Tokens, OAuth, organizations, and operators

| Event | Level | Fields | When |
| --- | --- | --- | --- |
| `api_token.create` | info | `kind: enum`, `tokenId: id`, `organizationId?: id`, `outcome: enum`, `code?: code` | An API token or an organization token is created. |
| `api_token.update` | info | `kind: enum`, `tokenId: id`, `organizationId?: id`, `outcome: enum`, `code?: code` | An API token or an organization token is changed. |
| `api_token.revoke` | info | `kind: enum`, `tokenId: id`, `organizationId?: id`, `outcome: enum`, `code?: code` | An API token or an organization token is revoked. |
| `jwt.mint` | info | `kid: id`, `userId: id`, `sessionId: id`, `outcome: enum`, `code?: code` | Core signs a session JWT. |
| `jwt.key_retire` | info | `kid: id`, `why: enum` | A signing key retires. `why` names the cause. |
| `oauth.authorize` | info | `clientRef: clientRef`, `outcome: enum`, `code?: code` | An authorization request gives a code, or is refused. |
| `oauth.token` | info | `grant: enum`, `clientRef: clientRef`, `outcome: enum`, `code?: code` | The token endpoint gives tokens for a grant, or refuses it. |
| `oauth.revoke` | info | `clientRef: clientRef`, `outcome: enum`, `code?: code` | A token of a client is revoked. |
| `oauth.client_register` | info | `clientRef?: clientRef`, `outcome: enum`, `code?: code` | An OAuth client is registered, or its registration is refused. |
| `organization.change` | info | `action: enum`, `organizationId: id` | An `after` hook point of the organizations runs. `action` is the point without `after`. |
| `organization.role_change` | info | `action: enum`, `organizationId: id`, `roleId: id` | A stored role of an organization is created, changed, or deleted. |
| `operator.action` | info | `action: enum`, `actorKind: enum`, `auditId: id` | An operator act commits with its audit row. |
| `operator.refused` | warn | `action?: enum`, `actorKind: enum`, `code: code` | The guard or `hooks.operator.beforeAction` refuses an operator act of a known actor. |
| `scim.change` | info | `resource: enum`, `action: enum`, `organizationId: id`, `resourceId: id` | A SCIM write commits, beside `hooks.scim.afterChange`. |
| `scim.owner_kept` | info | `scimUserId: id` | A SCIM deactivate keeps the member row of an owner. |
| `sso.second_factor_idp` | info | `connectionId: id`, `claim: enum` | The provider of an SSO sign-in passed the second factor. `claim` names the list that matched, never its value. |

### Limits, the sweep, and the port

| Event | Level | Fields | When |
| --- | --- | --- | --- |
| `limit.hit` | warn | `family: enum` | A limiter refuses a call. The event holds the family, never the key. |
| `sweep` | info | `verificationExpired: count`, `verificationConsumed: count`, `invitations: count`, `sessions: count`, `pendingSessions: count`, `apiTokens: count`, `organizationTokens: count`, `trustedDevices: count`, `jwks: count`, `oauthTokens: count`, `oauthClients: count`, `totpSetups: count`, `limits: count`, `oauthDevices: count`, `oauthSessionLinks: count`, `oauthLogouts: count`, `oauthClientSecrets: count`, `ssoDomains: count`, `ssoPendingDomains: count`, `scimTokens: count`, `organizationRows: count`, `durationMs: durationMs` | `api.sweepExpired()` ends. Each count is a key of its answer. |
| `observe.dropped` | warn | `buffer_full: count`, `sink_timeout: count`, `sink_threw: count` | The first event of a batch after a loss. Each count is the events lost since the last batch. |

### The fault events

| Event | Level | Fields | Default line |
| --- | --- | --- | --- |
| `observe.wait_until_threw` | error | `errorName: errorName` | `authtempo: waitUntil threw; the flush has no hook` |
| `secret.low_entropy` | warn | `secretIndex?: count`, `bits: count` | `authtempo: <path> has an estimated <bits> bits of entropy; 120 or more is recommended` |
| `secret.unknown_version` | error | `version: count`, `rowId: id` | `authtempo: a stored value names secret version <version>, which is not configured` |
| `error.internal` | error | `method: method`, `route: route`, `errorName: errorName` | `authtempo: unhandled error` |
| `captcha.port_threw` | error | `flow: enum`, `errorName: errorName` | `authtempo: the captcha port threw` |
| `captcha.no_answer` | error | `flow: enum` | `authtempo: the captcha did not answer` |
| `hook.copy_failed` | error | `hook: enum`, `errorName: errorName` | `authtempo: hook event copy failed` |
| `hook.before_failed` | error | `hook: enum`, `errorName: errorName` | `authtempo: before hook failed` |
| `hook.after_failed` | error | `hook: enum`, `rowId: id`, `errorName: errorName` | `authtempo: after hook failed` |
| `user.patch_refused` | error | `what: enum` | `authtempo: user patch refused` |
| `session.patch_refused` | error | `what: enum`, `field?: identifier` | `authtempo: session patch refused` |
| `user.hold_gave_up` | error | `userId: id` | `authtempo: user hold gave up` |
| `account.delete_gave_up` | error | `userId: id` | `authtempo: account delete gave up` |
| `email_change.gave_up` | error | `userId: id` | `authtempo: email change gave up` |
| `credential.removal_gave_up` | error | `userId: id` | `authtempo: credential removal gave up` |
| `profile.update_gave_up` | error | `userId: id` | `authtempo: profile update gave up` |
| `notice.mail_failed` | error | `event: identifier`, `errorName: errorName` | `authtempo: notice mail failed` |
| `email_code.count_gave_up` | error | `rowId: id` | `authtempo: email code count gave up` |
| `second_factor.count_gave_up` | error | `rowId: id` | `authtempo: second-factor challenge count gave up` |
| `backup_code.spend_gave_up` | error | `rowId: id` | `authtempo: backup code spend gave up` |
| `backup_code.replace_gave_up` | error | `rowId: id` | `authtempo: backup code replacement gave up` |
| `totp.reseal_failed` | error | `rowId: id`, `errorName: errorName` | `authtempo: a TOTP secret reseal failed` |
| `secrets.rewrap_failed` | error | `model: identifier`, `rowId: id`, `version: count` | `authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first` |
| `jwt.key_reseal_failed` | error | `kid: id`, `errorName: errorName` | `authtempo: a signing key reseal failed` |
| `jwt.key_unopened` | error | `kid: id` | `authtempo: a signing key does not open under this secret; it retires` |
| `jwt.claims_not_object` | error | none | `authtempo: jwtMint.claims answered a value that is not an object` |
| `jwt.claims_threw` | error | `errorName: errorName` | `authtempo: jwtMint.claims threw` |
| `passkey.registration_rejected` | error | `errorClass: errorClass` | `authtempo: passkey registration rejected` |
| `passkey.already_registered` | error | none | `authtempo: passkey credential already registered` |
| `passkey.authentication_rejected` | error | `errorClass: errorClass` | `authtempo: passkey authentication rejected` |
| `passkey.counter_moved` | error | none | `authtempo: passkey counter moved` |
| `passkey.credential_id_too_long` | error | none | `authtempo: passkey credential id over 1023 bytes` |
| `social.client_secret_failed` | error | `provider: name`, `errorClass: errorClass` | `authtempo: social client secret failed` |
| `social.token_request_failed` | error | `provider: name`, `errorClass: errorClass` | `authtempo: social token request failed` |
| `social.token_status` | error | `provider: name`, `status: status` | `authtempo: social token endpoint answered` |
| `social.token_missing` | error | `provider: name` | `authtempo: social token answer has no token` |
| `social.id_token_rejected` | error | `provider: name`, `errorClass: errorClass` | `authtempo: social id token rejected` |
| `social.nonce_mismatch` | error | `provider: name` | `authtempo: social nonce mismatch` |
| `social.user_info_failed` | error | `provider: name`, `errorName: errorName` | `authtempo: social user info failed` |
| `social.bad_subject` | error | `provider: name` | `authtempo: social user info has a bad subject` |
| `oidc.discovery_failed` | error | `provider: name`, `errorClass: errorClass` | `authtempo: oidc discovery request failed` |
| `oidc.discovery_status` | error | `provider: name`, `status: status` | `authtempo: oidc discovery answered` |
| `oidc.discovery_not_json` | error | `provider: name` | `authtempo: oidc discovery is not JSON` |
| `oidc.issuer_mismatch` | error | `provider: name` | `authtempo: oidc discovery issuer mismatch` |
| `oidc.endpoint_missing` | error | `provider: name` | `authtempo: oidc discovery lacks an endpoint` |
| `oauth.client_metadata_refused` | error | `why: enum`, `status?: status` | `authtempo: client metadata document refused` |
| `oauth.client_metadata_member_dropped` | warn | `member: identifier` | `authtempo: client metadata member dropped` |
| `oauth.client_key_set_refused` | error | `why: enum`, `status?: status` | `authtempo: client key set refused` |
| `oauth.client_auth_dropped` | error | `clientRef: clientRef`, `from: identifier` | `authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked` |
| `oauth.logout_dropped_attempts` | error | `clientRef: clientRef` | `authtempo: a back-channel logout is dropped after 6 attempts` |
| `oauth.logout_refused` | error | `clientRef: clientRef`, `status: status` | `authtempo: a back-channel logout is dropped: the client refused it` |
| `oauth.logout_attempt_failed` | error | `errorClass: errorClass` | `authtempo: a back-channel logout attempt failed` |
| `oauth.logout_delivery_failed` | error | `errorClass: errorClass` | `authtempo: the back-channel logout delivery failed` |
| `oauth.refresh_delete_failed` | error | `rowId: id`, `errorClass: errorClass` | `authtempo: the delete of a refresh row in a revoked grant failed` |
| `operator.step_failed` | error | `rowId: id`, `errorName: errorName` | `authtempo: operator step failed` |
| `operator.family_end_failed` | error | `rowId: id`, `errorName: errorName` | `authtempo: operator family end failed` |
| `operator.ban_write_gave_up` | error | `userId: id` | `authtempo: operator ban write gave up` |
| `operator.guard_refused` | error | `route: enum` | `authtempo: operator guard refused` |
| `operator.read` | error | `actor: enum`, `actorId: id`, `fn: identifier` | `authtempo: operator read` |
| `operator.route_unauthorized` | error | `route: route`, `reason: enum` | `authtempo: operator route unauthorized` |
| `role.row_invalid` | warn | `rowId: id` | `authtempo: role row invalid <rowId>` |
| `sweep.link_stopped` | error | `errorClass: errorClass` | `authtempo: the sweep link step stopped` |
| `sweep.outbox_stopped` | error | `errorClass: errorClass` | `authtempo: the sweep outbox step stopped` |
| `sweep.pending_end_stopped` | error | `errorClass: errorClass` | `authtempo: the sweep pending end step stopped` |
| `sweep.sso_recheck_stopped` | error | `errorClass: errorClass` | `authtempo: the sweep sso recheck step stopped` |
| `sweep.organization_rest_stopped` | error | `errorClass: errorClass` | `authtempo: the sweep organization rest step stopped` |
| `sso.guard_refused` | error | `step: enum` | `authtempo: sso guard refused` |
| `sso.failed` | error | `connectionId: id`, `step: enum` | `authtempo: sso failed` |
| `sso.denied` | error | `connectionId: id` | `authtempo: sso denied` |
| `sso.refused` | error | `connectionId: id`, `code: code` | `authtempo: sso refused` |
| `saml.certificate_expired` | warn | `connectionId: id` | `authtempo: saml certificate expired` |
| `sso.client_secret_unopened` | error | `rowId: id` | `authtempo: an sso client secret did not open` |
| `sso.domain_unverified` | error | `port: name`, `domainId: id` | `authtempo: sso domain unverified` |
| `sso.domain_lost` | error | `rowId: id` | `authtempo: sso domain lost` |

## The closed lists

An enum field takes only the values of its list. A long list names its count and its source.

| Field | Values |
| --- | --- |
| `request.outcome` | `ok`, `redirect`, `client_error`, `denied`, `limited`, `server_error` |
| `sign_in.method` | `password`, `magic_link`, `social`, `passkey`, `handoff`, `email_otp`, `impersonation`, `sso` |
| `sign_in.outcome` | `success`, `failure`, `second_factor_required` |
| `sign_up.method` | `password`, `magic_link`, `social`, `passkey`, `handoff`, `email_otp`, `sso`, `password_reset`, `operator`, `scim` |
| `sign_up.outcome` | `success`, `failure` |
| `sign_out.outcome` | `success`, `failure` |
| `session.end.reason` | `sign_out`, `password_reset`, `password_change`, `claim`, `expired`, `two_factor`, `revoked`, `email_change`, `account_deleted`, `oidc_logout`, `banned`, `operator`, `impersonation_end` |
| `second_factor.challenge.method` | `totp`, `passkey`, `email`, `backup_code`, `trusted_device` |
| `second_factor.challenge.outcome` | `success`, `failure` |
| `second_factor.enable.method` | `totp`, `passkey`, `email` |
| `second_factor.enable.outcome` | `success`, `failure` |
| `second_factor.disable.method` | `totp`, `passkey`, `email` |
| `second_factor.disable.outcome` | `success`, `failure` |
| `backup_codes.regenerate.outcome` | `success`, `failure` |
| `passkey.register.outcome` | `success`, `failure` |
| `passkey.delete.outcome` | `success`, `failure` |
| `password.reset_request.outcome` | `success`, `failure` |
| `password.reset.outcome` | `success`, `failure` |
| `password.change.outcome` | `success`, `failure` |
| `email.verify.method` | `password_verify`, `magic_link`, `email_otp`, `social`, `password_reset`, `sso`, `scim` |
| `email.verify.outcome` | `success`, `failure` |
| `reauth.method` | `password`, `email_otp`, `passkey` |
| `reauth.outcome` | `success`, `failure` |
| `captcha.port_threw.flow` | `password-sign-up`, `password-sign-in`, `magic-link-request`, `email-otp-request`, `password-reset-request` |
| `captcha.no_answer.flow` | `password-sign-up`, `password-sign-in`, `magic-link-request`, `email-otp-request`, `password-reset-request` |
| `hook.copy_failed.hook` | 46 values: each hook name, `<group>.<point>`, from the seven hook point constants. [Run your code at a hook point](/docs/guides/hooks/) lists the points. |
| `hook.before_failed.hook` | 46 values: each hook name, `<group>.<point>`, from the seven hook point constants. [Run your code at a hook point](/docs/guides/hooks/) lists the points. |
| `hook.after_failed.hook` | 46 values: each hook name, `<group>.<point>`, from the seven hook point constants. [Run your code at a hook point](/docs/guides/hooks/) lists the points. |
| `user.patch_refused.what` | `a value that is not an object`, `a value that cannot be read`, `a value that is not a plain object`, `a field other than name and image`, `a name that breaks the name rule`, `an image that breaks the image rule` |
| `session.patch_refused.what` | `a value that is not an object`, `a value that cannot be read`, `a value that is not a plain object`, `an ip that is not a string or null`, `a userAgent that is not a string or null`, `an activeOrganizationId that is not a string or null`, `field` |
| `oauth.client_metadata_refused.why` | 28 values: the fetch guards, `status`, the type and size rules, and each rule of a member. |
| `oauth.client_key_set_refused.why` | `no fetch`, `the fetch failed or timed out`, `not JSON`, `not a JSON object`, `status`, `not application/json or application/jwk-set+json`, `larger than 65536 bytes, not UTF-8, or not in time`, `no keys array`, `no public signing key` |
| `operator.guard_refused.route` | 187 values: each route key of [Routes](/docs/reference/routes/), and `api` for a call of `auth.api`. |
| `operator.read.actor` | `secret`, `user`, `app` |
| `operator.route_unauthorized.reason` | `secret_mismatch`, `secret_and_session`, `secret_not_accepted`, `no_session` |
| `api_token.create.kind` | `tk`, `to` |
| `api_token.create.outcome` | `success`, `failure` |
| `api_token.update.kind` | `tk`, `to` |
| `api_token.update.outcome` | `success`, `failure` |
| `api_token.revoke.kind` | `tk`, `to` |
| `api_token.revoke.outcome` | `success`, `failure` |
| `jwt.mint.outcome` | `success`, `failure` |
| `jwt.key_retire.why` | `rotate`, `timer`, `alg`, `unopened` |
| `oauth.authorize.outcome` | `success`, `failure` |
| `oauth.token.grant` | `authorization_code`, `refresh_token`, `client_credentials`, `urn:ietf:params:oauth:grant-type:device_code` |
| `oauth.token.outcome` | `success`, `failure` |
| `oauth.revoke.outcome` | `success`, `failure` |
| `oauth.client_register.outcome` | `success`, `failure` |
| `organization.change.action` | `create`, `update`, `delete`, `addMember`, `updateMemberRole`, `removeMember`, `invite`, `acceptInvitation`, `declineInvitation`, `revokeInvitation`, `createTeam`, `updateTeam`, `deleteTeam`, `addTeamMember`, `removeTeamMember` |
| `organization.role_change.action` | `create`, `update`, `delete` |
| `operator.action.action` | 28 values: each action of an audit row, the 18 of SSO and SCIM too. [Routes](/docs/reference/routes/) lists them under the operator audit. |
| `operator.action.actorKind` | `secret`, `user`, `app`, `scim` |
| `operator.refused.action` | 28 values: each action of an audit row, the 18 of SSO and SCIM too. [Routes](/docs/reference/routes/) lists them under the operator audit. |
| `operator.refused.actorKind` | `secret`, `user`, `app`, `scim` |
| `limit.hit.family` | 75 values: each family of [Limits](/docs/reference/limits/). |
| `sso.guard_refused.step` | `impersonation`, `rank`, `email`, `second_factor`, `fresh` |
| `sso.failed.step` | 30 values: each refused step of an OIDC start or callback, and of a SAML post. [Errors](/docs/reference/errors/) names the steps under `sso_failed`. |
| `sso.second_factor_idp.claim` | `amr`, `acr`, `authnContext` |
| `scim.change.resource` | `User`, `Group` |
| `scim.change.action` | `create`, `update`, `deactivate`, `delete` |

## The field kinds

No kind is free text. A field that fails its kind is dropped, and its name goes into `rejected`.

| Kind | What it holds |
| --- | --- |
| `id` | A row id: 1 to 64 letters, digits, `_`, or `-`. |
| `enum` | One value of the closed list of the field. |
| `code` | A key of the error codes or of the OAuth error codes. |
| `route` | A route key, or `unmatched`. |
| `routePath` | A path of a route. |
| `name` | A lowercase name of at most 32 characters, such as a provider. |
| `identifier` | A name in the form of a JavaScript identifier, at most 64 characters. |
| `errorName` | The name of a thrown error. A name that breaks the rule writes `Error`. |
| `errorClass` | The class of a thrown value, else `Error`. |
| `count` | An integer of 0 or more. |
| `durationMs` | A time in milliseconds, an integer of 0 or more. |
| `status` | An integer of 0 or more, such as an HTTP status. Core does not check the range of an HTTP status. |
| `hash` | 32 lowercase hex. |
| `clientRef` | A `cl_` client id, or `cimd:` and the first 32 hex of the SHA-256 of a metadata document URL. |
| `method` | An HTTP method token of RFC 9110, at most 32 characters. |

## Next

- [Observability](/docs/operations/observability/)
- [Limits](/docs/reference/limits/)
- [The threat model](/docs/concepts/threat-model/)
