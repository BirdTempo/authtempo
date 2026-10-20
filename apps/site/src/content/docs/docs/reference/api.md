---
title: The API reference
description: The auth object that createAuth answers, its in-process api, and every export of @authtempo/core.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 5
  - packages/core/src/create-auth.ts
  - packages/core/src/index.ts
  - packages/core/src/routes.ts
  - packages/core/src/credentials.ts
  - packages/core/src/operator-secret.ts
  - packages/core/src/secrets-entry.ts
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
  - docs/superpowers/plans/2026-10-14-11g-openapi.md
  - docs/superpowers/plans/2026-10-14-12e-oauth-provider-v2.md "Task 2"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 4"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 5"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 7"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 8"
---

**For:** a developer who calls core from server code, or looks for an export of `@authtempo/core`.

**What it does:** this page lists the members of the auth object and every export of the core entry. The export check holds this page to `packages/core/src/index.ts`. Four more export checks hold it to the route, credential, operator secret, and secrets entries.

## Before you start

- Read [Configuration](/docs/reference/config/) for the input of `createAuth`.

## The auth object

`createAuth(config)` answers an `Auth`. It throws `ConfigError` for a config that breaks a rule.

| Member | What it does |
| --- | --- |
| `handle(request)` | Serves the routes under `basePath`. Mount it for each path that starts with `basePath`. |
| `session(request, options?)` | Answers the `ResolvedSession` of the cookie or the `ts_` bearer token, or null. A `tk_` token answers null. With `{ refresh: false }`, the read writes nothing: no sliding refresh and no delete of an ended row. |
| `caller(request)` | Answers a `Caller`: a session, an API token, or an OAuth access token under its resource, or null. A `client_credentials` token answers `kind: "oauth-client"`, with no user. An `oauth` caller has `user` and `subject`, the token's `sub`: the user id, or the pairwise subject of a pairwise client. |
| `sessionCookie(request, resolved)` | Answers the `Set-Cookie` value after a sliding refresh, or null. Send it, or the browser drops the cookie early. |
| `wellKnown(request)` | Serves the documents under `/.well-known/` at the origin root. 404 while `oauth` is off. |
| `api` | The same operations in-process, as an `AuthApi`. |
| `errors` | The table `ERRORS`. |

## The in-process api

Each call answers a `Result`: `{ ok: true, value }` or `{ ok: false, code, status }`. A failed `Result` of `hook_refused` also carries `message`. No call checks the `Origin` header, so a server route that calls one must check its own caller.

| Group | Calls |
| --- | --- |
| Rows | `sweepExpired()`, which answers a `SweepResult` |
| Sessions | `getSession(token)`, `signOut(token)`, `setActiveOrganization` |
| Magic link | `requestMagicLink`, `verifyMagicLink` |
| Social sign-in | `startSocial`, `startLink`, `completeSocial` |
| Passkeys | `passkeyRegistrationOptions`, `verifyPasskeyRegistration`, `passkeyAuthenticationOptions`, `verifyPasskeyAuthentication`, `listPasskeys`, `deletePasskey`, `renamePasskey`. `renamePasskey` needs no fresh session |
| Handoff | `startHandoff`, `continueHandoff`, `redeemHandoff` |
| Organizations | `createOrganization`, `listOrganizations`, `updateOrganization`, `deleteOrganization`, `listMembers`, `addMember`, `updateMemberRole`, `removeMember`, `inviteMember`, `listInvitations`, `revokeInvitation`, `acceptInvitation`, `declineInvitation` |
| `api.tokens` | `create`, `list`, `revoke`, `current` |
| `api.session` | `requireFresh(resolved)`, `reauthenticate`, `requestReauthCode`, `reauthPasskeyOptions`, `list`, `revoke`, `revokeOthers`, `refresh(token)`; present in every deployment. `refresh` slides the expiry as `POST /session/refresh` does. `api.passkeyRegistrationOptions`, `api.deletePasskey`, `api.tokens.create`, `api.totp.disableWithCode`, and `api.totp.regenerateBackupCodesWithCode` take a user and apply no fresh rule: call `requireFresh` first. [Fresh sessions](/docs/concepts/fresh-sessions/) |
| `api.user` | `update`, `changeEmail`, `confirmEmailChange`, `verifyEmailChange`, `delete`, `confirmDelete`; present in every deployment. `verifyEmailChange` answers `not_found` with `emailOtp: false`. `delete` and `confirmDelete` answer `not_found` with `account.delete: false`. With `account.deleteConfirm` on, `delete` mails a link and answers `{ sent: true }` |
| `api.identities` | `list`, `unlink`; present in every deployment. `unlink` has the fresh rule and the last-credential guard |
| `api.password` | `signUp`, `signIn`, `verify`, `verifyEmail`, `resendVerification`, `requestReset`, `reset`, `change`; present when `password` is set |
| `api.emailOtp` | `request`, `verify`, `requestReset`, `reset`; present unless `emailOtp` is `false` |
| `api.totp` | `setup`, `enable`, `verify`, `disable`, `disableWithCode`, `regenerateBackupCodes`, `regenerateBackupCodesWithCode`, `status`, `uri`, `revokeTrustedDevices`; present when the second factor is on. `disable` turns every method off |
| `api.jwt` | `mint`, `verify`, `rotate`, `jwks`, `sessionLive`; present unless `jwtMint` is `false` |
| `api.oauth` | `grants`, `revoke`, and `clients` (`create`, `get`, `list`, `update`, `delete`, `rotateSecret`); present when `oauth` is set |
| `api.secrets` | `status`, `rewrap`; present in every deployment, in process only. `status()` answers, for each version of the app secret, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, and `emailCodes` (live codes only). A version that a row names and the config lacks has `configured: false`. `status` reads every row of the TOTP, second factor, signing key, and code tables: one query per 1000 rows of each table. `rewrap({ limit, after })` reseals up to `limit` (1 to 1000, default 100) TOTP secrets and signing keys under the current version, and answers `{ resealed, failed, skipped, more, next }`. Pass `next` as `after` until `next` is `null` |
| `api.operator` | `audit.list`, `users.list`, `users.search`, `users.get`, `platformRole.grant`, `platformRole.revoke`, `secondFactor.disable`, `createAdmin`, `sessions.endUser`, `sessions.endAll`; present in every deployment. Each call answers `not_found` while `operator.users` is off. Each call takes `actor`, for example the app as `{ kind: "app", name }`. The name has 1 to 64 characters of `[a-z0-9_.-]`. Each call answers `invalid_body` for another name, also while the tool is off. A `reason` has 1 to 500 characters with no control character and no lone surrogate, else the call answers `invalid_body`. `audit.list({ actor, targetUserId?, after?, limit? })` answers the audit rows by `id` ascending. `limit` is 1 to 100, default 50. `next` is set when the page is full. A secret actor needs the scope `audit`. `users.list({ actor, after?, limit? })` answers `{ users, next }` by `id` ascending, with no total. For a core id, this is about the order of creation. `limit` is 1 to 100, default 50, and `next` is set only when more users follow. `users.search({ actor, email?, emailPrefix?, id?, after?, limit? })` takes exactly one key, else `invalid_body`. `email` and `id` are exact and answer zero or one user. `emailPrefix` has 3 to 254 characters after the address rule (trimmed, lowercase). It matches the start of the address with case and with no wildcard, by address order. A prefix search reads the whole user table. An app call in process counts on no limiter, so the app bounds its own loop of searches. A page costs at most 7 storage calls, whatever its size. One `in` read each takes the member, second-factor, session, and identity rows of the page. D1 allows 50 queries per invocation on Workers Free and 1000 on Workers Paid (D1 limits page, read 2026-10-20). The Workers limits page (read 2026-10-20) gives Free 50 subrequests and 1,000 to internal services. A prefix `after` answers `invalid_body` when its user is gone or its address no longer starts with the prefix. A search with no match answers `{ users: [], next: null }`. `users.get({ actor, userId })` answers one user or `not_found`. A user holds `id`, `email`, `emailVerified`, `name`, `createdAt`, `ban`, and `platformOperator`. It also holds `secondFactor` (the method names), `sessions` (the live count, at most 100), and `identities` (the provider names). It holds no hash, no sealed value, no token, and no provider subject. A users call needs the scope `users` and writes one log line with no address. `platformRole.grant({ actor, userId, reason, ip, userAgent })` and `platformRole.revoke` take the same keys and answer `{ auditId }`. Each answers `not_found` while `organizations.platformRole` is unset, and also when no platform organization exists. A secret actor without the scope `users` gets `operator_required`. The grant needs a verified address (`email_unverified`) and no active ban (`account_banned`). It adds the platform role part to the member row of the platform organization, or makes the row with the role alone. A new row in a full platform organization answers `member_limit`. The revoke removes the part, and a row with no part left goes. A revoke that would leave the platform organization with no owner answers `last_owner`. The revoke ends every session, challenge, and handoff code of the user, and the OAuth refresh tokens and codes. The API tokens stay. A user actor gets `operator_self` for their own user and `operator_required` for a platform operator. A grant to a user who holds the role, and a revoke of a user who does not, change nothing and still write the audit row. A parallel change of the member row answers `conflict`. The member hooks run with `via: "operator"`, and `by` is null for a secret or the app. `secondFactor.disable({ actor, userId, reason, proof, ip, userAgent })` answers `{ auditId }`. It turns every method of the second factor off after identity proofing (ASVS 5.0.0 6.4.4). `proof` is `{ method, reference, checkedAt }`. `method` is `document`, `in_person`, `video`, `knowledge`, or `other`. `reference` is the case id of the check in the app's own system, 1 to 200 characters with no control character and no lone surrogate. It is never the evidence, because the audit table holds no personal document. `checkedAt` is an ISO date and time with a zone, from 7 days before now to now. Another proof answers `invalid_body`. The audit row holds the proof in `data`. A user with the factor off answers `totp_not_enabled`, and no row is written. A secret actor without the scope `users` gets `operator_required`. A user actor gets `operator_self` for their own user and `operator_required` for a platform operator. After the commit the user gets the notice `factor_disabled`, unless `account.notices` is false. The notice holds no IP and no user agent of the operator. The disable ends no session. It holds the user row before its deletes, as the account delete does. It costs eight storage calls, and ten for a user actor. `createAdmin({ actor, email, name?, reason, ip, userAgent })` answers `{ userId, created, auditId }`, and a user actor gets `operator_required`. A bad address or name answers `invalid_body`. One transaction makes the platform organization when it is absent, with the name `appName`. It makes the user when no user holds the address, with no password and an address that is not verified. Then it writes the member row: `owner` and the platform role in a new organization, else the role part as the grant does. `created` is true only for a new user. A user with an active ban gets `account_banned`. A parallel request that makes the platform organization or the user first answers `conflict`. The new operator has no power before a proof of the mailbox and a second factor. `sessions.endUser({ actor, userId, reason, callsUsed?, ip, userAgent })` answers `{ ended, more, auditId }`. It ends every session, challenge, and handoff code of one user, and the OAuth refresh tokens and codes. The API tokens stay. A user actor gets `operator_self` for their own user and `operator_required` for a platform operator. It works in pages, as `sessions.endAll` does, and each call fits the same budget, the steps after the commit too; call again while `more` is true. Each call holds the user row and deletes the challenges, a page of the sessions, and the handoff codes. When no session stays, it deletes the refresh tokens of as many OAuth families as the calls left allow, and the OAuth codes. It sends no back-channel sign-out message in the call. The messages are due now, and the sweep sends them, so the cost of a call does not depend on a signature. `users.ban` and `platformRole.revoke` also leave their messages to the sweep. The end marks of the OAuth families come after the commit, inside the budget. When that step fails, the answer holds `familyEndFailed: true` and `more: true`, and the next call ends the families again. A `callsUsed` that leaves the work fewer than 20 calls, and 22 for a user actor, answers `invalid_body`. `sessions.endAll({ actor, reason, limit?, callsUsed?, ip, userAgent })` answers `{ ended, more, auditId }`. It ends up to `limit` sessions of all users by `id` ascending, never the session of a user actor. `limit` is 1 to 1000, default 500; call again while `more` is true. It ends the sessions only: the challenges, the handoff codes, and the OAuth tokens stay. The back-channel sign-out messages of the ended sessions are due now, and the sweep sends them. A whole invocation fits 50 storage calls: the calls before the call, the work, and the audit row. `callsUsed` is the count of storage calls of the invocation before the call, 0 to 49. Without it the call takes the worst case of the actor: 8 for a user actor, 1 for a secret, and 0 for the app. The ready check of the storage comes on top: `readyStatements`, or 1 when the storage has none. A core D1 adapter answers 1, so the work gets 48 calls for the app and 40 for a user actor. The D1 storage of the Better Auth tables answers 4: its check also reads the indexes of the account table. A count that leaves the work fewer than 4 calls answers `invalid_body`. The page ends the most sessions whose reads and deletes fit the budget, and one at the least, and answers `more: true` when rows stay. Each page first takes the row locks of its sessions by id in one statement, so it waits on no ban and no account delete that waits on it. For n sessions, a page costs 3 + 2 ceil(n / 50) storage calls with the lock. That is 23 for 500 sessions. With a `session.afterEnd` hook it costs 3 + ceil(n / 50) + n, so a page of the app ends 45 sessions. D1 has no row lock and sends 1 less. The calls left write the sign-out messages of the client links, 2 calls per link. The other links stay with no session, and the sweep writes and sends their messages. So a session ends in its call, whatever its count of client links. D1 allows 50 queries per invocation on Workers Free and 1000 on Workers Paid (D1 limits page, read 2026-10-21). A call fits both. A sessions call needs the scope `sessions` and writes one audit row |

## Functions

| Export | What it does |
| --- | --- |
| `createAuth` | Makes the auth object from a config. |
| `createMemoryAdapter` | A storage adapter in memory, for tests and examples. |
| `createMemoryLimiter` | A limiter in memory, per isolate, for tests. It is the default. |
| `createPbkdf2PasswordHash` | The default password hash: PBKDF2-HMAC-SHA256, 100000 iterations. |
| `crossSiteRefusal` | Takes an `Auth` and a request. It answers the 403 `origin_not_trusted` that `auth.handle` gives a POST before any handler, or null. A package that serves its own POST paths beside `auth.handle` calls it first. |
| `createJoseJwtSeam` | The default JWT seam, on jose. |
| `createSimpleWebAuthnSeam` | The default WebAuthn seam, on @simplewebauthn/server. |
| `createDeriveGate`, `deriveGate` | A gate that lets at most two legacy password derives run at once per isolate, and the shared gate. |
| `hookRefusal` | Makes the error that a before hook throws to refuse a flow with a message. |
| `systemClock` | The clock of the system. |
| `schema` | The models and the fields of the storage port. |
| `defaultConfirmPage`, `defaultSignInPage`, `defaultHandoffConfirmPage`, `defaultResetPage`, `defaultPasswordVerifyPage`, `defaultTotpPage`, `defaultConsentPage`, `defaultDevicePage`, `defaultEmailChangePage` | The default pages. [Replace the default pages](/docs/guides/pages/) tells how to replace one. |
| `defaultAccountDeletePage` | The page of the mailed delete link (`account.deleteConfirm`). No key replaces it. An app that serves its own page posts the token with `client.user.confirmDelete`. |
| `defaultEmailOtpMail`, `defaultResetOtpMail`, `defaultSecondFactorMail`, `defaultAccountMail`, `defaultNoticeMail` | The default mails of the email codes and of the settings page. `defaultSecondFactorMail` is the mail of a second-factor email code. `defaultNoticeMail` is the notice after a change of a way in. |
| `defaultExistingAccountMail` | The default mail to a known address at a uniform sign-up. `password.existingAccountMail` replaces it. |
| `limiterKey` | Joins a key, the seconds, and the maximum into the stored key of the owned limiters. |
| `ipKey` | The IP part of a per-IP limiter key: the IPv4 form of an IPv4-mapped address, the `/64` of another IPv6 address, `unknown` for no IP. |
| `isIpLiteral` | True for a bare IPv4 or IPv6 literal. The notice mail prints an IP only in this form. |
| `normalizeEmail`, `normalizeSlug` | The address rule and the slug rule of core. |
| `validOrganizationName`, `validUserName` | The name rules of core. A user name has 1 to 200 code units and no control, format, line separator, paragraph separator, or lone surrogate character. The zero-width non-joiner and joiner pass. |
| `validImageUrl` | The image rule of core: an `https://` URL with a host, of at most 2048 characters, with no `@` and no `%` in its authority. It holds no whitespace, no control or format character, no backslash, and none of `"<>{}\|^` or a backtick. |
| `rankOf` | The rank of a role string in a rank table. |
| `readSessionToken` | Reads the session token of a request, from the cookie and then the bearer header. |
| `isAppScheme`, `isGithubSubject` | The app scheme rule, and the rule of a GitHub subject. |
| `newId` | Makes a row id. |
| `checkCaptcha` | The captcha check of one flow, after its per-IP limit and before its per-email limits. It answers null when the flow goes on. An `api` call with no `captchaToken` skips it, so an app that proxies a browser request through `api` must pass the browser's token. |

## Classes and constants

| Export | What it is |
| --- | --- |
| `ConfigError` | The error of a config that breaks a rule. Its message names the key. |
| `StorageError` | The error of an adapter, with a code such as `unique_violation` or `schema_mismatch`. |
| `HookRefusal` | The class of the error that `hookRefusal` makes. |
| `ERRORS`, `OAUTH_ERRORS` | The error tables: each code with its status. [Error codes](/docs/reference/errors/) lists them. |
| `VERSION` | The version of core. |
| `SCHEMA_VERSION` | The schema version that this core needs. |
| `API_TOKEN_PREFIX` | `tk_`. |
| `DEFAULT_RESERVED_SLUGS` | The default reserved slugs. |
| `DELETE_CONFIRM_TTL_MINUTES` | The bounds and the default of `account.deleteConfirm.ttlMinutes`: 5, 1440, and 60. |
| `DEFAULT_SESSION_COOKIE` | `__Host-tempo_session`, the default name of the session cookie. |
| `DERIVE_GATE_MAX` | 2, the derives that the gate lets run at once. |
| `HOOK_REFUSED_TEXT` | The message for a refusal with no valid message. |
| `KEY_SEPARATOR` | U+001F, the separator of `limiterKey`. |
| `LEGACY_SESSION_COOKIE` | `tempo_session`, the old session cookie. For one release core reads it and moves it. |
| `LEGACY_VERIFY_HASH` | The hash value of a user whose password the old system checks. |
| `PBKDF2_ITERATIONS` | 100000. |
| `PENDING_HASH_PREFIX` | The prefix of a password row that an import repair holds back. |
| `CAPTCHA_FLOWS`, `DEFAULT_CAPTCHA_FLOWS` | The five flows that a captcha can check, and the four that it checks by default. |
| `CAPTCHA_HEADER` | `x-captcha-response`, the header of the captcha token. |
| `CAPTCHA_TOKEN_MAX` | 2048. A longer token answers `captcha_failed` with no call. |
| `PROVIDER_NAME_RE`, `ROLE_RE`, `TWO_FACTOR_TOKEN_RE` | The patterns of a provider name, a role, and a second factor challenge. |

## Types

Each type is exported for an app that writes its own seam, page, or adapter.

| Area | Types |
| --- | --- |
| The auth object | `Auth`, `AuthApi`, `SessionApi`, `UserApi`, `IdentitiesApi`, `PublicUser`, `Caller`, `Result`, `Awaitable`, `PublicSession`, `ResolvedSession`, `ResolvedApiToken`, `SweepResult`, `Clock` |
| Config | `AuthConfig`, `SecretVersion`, `Keyring`, `AppleConfig`, `GoogleConfig`, `GitHubConfig`, `LinkedInConfig`, `OidcEntry`, `OidcEndpoints`, `OAuth2Entry`, `OrganizationsConfig`, `OrganizationLimits`, `PasswordConfig`, `LegacyVerifyConfig`, `EmailOtpConfig`, `TotpConfig`, `TotpGateConfig`, `JwtMintConfig`, `OAuthConfig`, `OperatorConfig`, `OperatorSecretEntry`, `OperatorScope`, `HooksConfig`, `CaptchaConfig`, `AccountConfig`, `AccountNoticesConfig`, `AccountDeleteConfirmConfig` |
| Ports and seams | `StorageAdapter`, `LimiterPort`, `LimitWindow`, `MailPort`, `MailMessage`, `PasswordHashSeam`, `JwtSeam`, `WebAuthnSeam`, `DeriveGate`, `SignES256Input`, `VerifyIdTokenInput`, `JwsAlg`, `PublicJwk` |
| Storage | `ModelName`, `Models`, `Where`, `Op`, `Sort`, `FindManyOptions`, `UserRow`, `IdentityRow`, `SessionRow`, `VerificationRow`, `PasskeyRow`, `PasswordRow`, `ApiTokenRow`, `OrganizationRow`, `MemberRow`, `InvitationRow`, `TotpRow`, `TrustedDeviceRow`, `SecondFactorRow`, `SecondFactorMethod`, `JwkRow`, `OAuthClientRow`, `OAuthConsentRow`, `OAuthTokenRow`, `OAuthDeviceRow`, `OAuthSubjectRow`, `OAuthSessionClientRow`, `OAuthLogoutRow`, `ClientAuthMethod`, `DeviceStatus`, `OperatorAuditRow`, `OperatorAction` |
| Errors | `ErrorCode`, `OAuthErrorCode` |
| Pages and mails | `ConfirmPageInput`, `SignInPageInput`, `HandoffConfirmPageInput`, `ResetPageInput`, `PasswordVerifyPageInput`, `TotpChallengePageInput`, `ConsentPageInput`, `DevicePageInput`, `DEVICE_WARNING`, `EmailOtpMailInput`, `ExistingAccountMailInput`, `AccountMailInput`, `NoticeEvent`, `NoticeMailInput`, `EmailChangePageInput`, `AccountDeletePageInput` |
| Magic link and social | `MagicLinkRequest`, `MagicLinkVerify`, `SocialStart`, `SocialStarted`, `SocialComplete`, `SocialProfile`, `SocialProviderName` |
| Passkeys | `PasskeySummary`, `RegisteredPasskey`, `AuthenticatedPasskey`, `PublicKeyCredentialCreationOptionsJSON`, `PublicKeyCredentialRequestOptionsJSON`, `RegistrationResponseJSON`, `AuthenticationResponseJSON` |
| Handoff | `HandoffStart` |
| Passwords | `PasswordApi`, `PasswordSignUp`, `PasswordSignUpResult`, `PasswordSignUpPending`, `PasswordSignIn`, `PasswordSignInResult`, `PasswordSession`, `PasswordVerify`, `PasswordVerified`, `PasswordResend`, `PasswordResetRequest`, `PasswordReset`, `ResetResult`, `ResetChallenge`, `PasswordChange`, `PasswordReauth` |
| Email codes | `EmailOtpApi`, `EmailOtpRequest`, `EmailOtpVerify`, `EmailOtpReset`, `EmailOtpSession`, `ResolvedEmailOtp` |
| Second factor | `TotpApi`, `TotpSetup`, `TotpSetupInput`, `TotpStatus`, `TwoFactorPending`, `TwoFactorSession`, `TwoFactorVerify`, `ChallengeMethod`, `SignInChallenge`, `MethodEnabled`, `ChallengeView` |
| API tokens | `TokensApi`, `ApiTokenCreate`, `ApiTokenSummary` |
| Account | `ReauthInput`, `ReauthProof`, `SessionSummary`, `ProfileUpdate`, `EmailChangeRequest`, `IdentityEntry`, `IdentityList`, `IdentityUnlink`, `SocialLinked`, `SocialLinkStart`, `AccountDelete` |
| App secrets | `SecretsApi`, `SecretsStatus`, `SecretsRewrap`, `SecretVersionCount` |
| Operator tools | `OperatorApi`, `OperatorActor`, `OperatorAuditDraft`, `OperatorUser` |
| JWT and OAuth | `JwtApi`, `MintedJwt`, `SessionJwtClaims`, `TokenAnswer`, `OAuthApi`, `OAuthClientsApi`, `OAuthAccess`, `OAuthClientAccess`, `CREDENTIALS_PER_CLIENT`, `DEVICE_GRANT`, `DEVICE_START_PER_IP`, `DEVICE_VERIFY_PER_SESSION`, `DEVICE_VERIFY_PER_IP`, `DEVICE_VERIFY_PER_CODE`, `DeviceAuthorizationAnswer`, `OAuthGrantSummary`, `OAuthResult`, `ClientInput`, `ClientSummary`, `ClientFields`, `RegisteredClient`, `CLIENT_SECRET_PREFIX` |
| Organizations | `OrganizationSummary`, `MemberSummary`, `InvitationSummary`, `OrganizationPatch`, `ProposedMember` |
| Captcha | `CaptchaPort`, `CaptchaPage`, `CaptchaFlow` |
| Hooks | `OrganizationHooks`, `OrganizationHookEvent`, `SessionHooks`, `SessionDraft`, `SessionPatch`, `SessionVia`, `SessionEndReason`, `MemberVia`, `RemoveVia`, `UserHooks`, `UserCreatePatch`, `UserPatch`, `UserCreateVia`, `UserUpdateVia`, `UserVerifyVia`, `IdentityHooks`, `IdentitySummary`, `IdentityLinkVia`, `OperatorHooks` |

## The other entries

| Entry | What it exports |
| --- | --- |
| `@authtempo/core/errors` | The error tables alone, for a client bundle. |
| `@authtempo/core/conformance` | `runAdapterConformance`, the suite of every storage adapter. |
| `@authtempo/core/limiter-conformance` | The suite of every limiter. |
| `@authtempo/core/sql` | The SQL helpers that both adapters share. |
| `@authtempo/core/testing` | `SoftAuthenticator`, `totpCode`, `base32Decode`, `ROUTES`, the route list, and `TEST_SECRET`, the app secret of the tests. |
| `@authtempo/core/routes` | The route facts of an SDK. The next part lists them. |
| `@authtempo/core/credentials` | The credential facts of an SDK. The part after it lists them. |
| `@authtempo/core/operator-secret` | The form of the operator secret, for the CLI, not for an app. The part before the last lists it. |
| `@authtempo/core/secrets` | The rules of the app secret, for the CLI, not for an app. The last part of this page lists it. |

## The route entry

An SDK imports `@authtempo/core/routes`, never `@authtempo/core/testing`, which also holds the soft authenticator.

| Export | What it is |
| --- | --- |
| `ROUTES` | Every route that core can serve, with literal types. [Routes](/docs/reference/routes/) holds each route. |
| `RouteEntry` | One row of `ROUTES`: `method`, `path`, `feature`, `auth`, `codes`, `oauthCodes`, and `crossSiteForm` on the one cross-site form post. |
| `RouteFeature` | The config part that turns a route on. |
| `ROUTE_FEATURES` | Every feature once, as a tuple. `RouteFeature` is one of its members. |
| `AuthForm` | A credential form that a route takes: `none`, `session`, `apiToken`, `sessionJwt`, `accessToken`, `dpopAccessToken`, `operator`, `initialAccessToken`, or `clientSecretBasic`. |
| `RouteMethod` | `GET` or `POST`. |
| `RouteLiteral` | One row of `ROUTES` with its literal method and path. |
| `RoutePath` | A path that `ROUTES` holds for a method. An SDK types its paths with it, so a path that core does not serve fails the compile. |
| `RouteKey` | `"<METHOD> <path>"` of one row of `ROUTES`. A key that `ROUTES` does not hold fails the compile. |
| `ROUTER_CODES`, `RouterCode` | The codes that the router answers for every route: `not_found`, `origin_not_trusted`, and `internal`. An entry's `codes` never repeats them. |
| `PROVIDER_NAME_RE` | The name rule of `:provider`. |
| `AUTH_ERROR_PARAM` | The query parameter of a browser flow failure, `auth_error`. |
| `routeAnchor` | The anchor of a route on [Routes](/docs/reference/routes/): the method, then the path with each run of other characters as one hyphen. |
| `errorAnchor`, `ErrorTable` | The anchor of a code on [Errors](/docs/reference/errors/), and the table of the code: `core` or `oauth`. |
| `DOCS_ORIGIN` | The origin of the docs, `https://authtempo.com`. |

## The credential entry

`@authtempo/core/credentials` holds the facts of each credential that core issues. The engine and every SDK read them here. The entry pulls no engine module into a bundle.

| Export | What it is |
| --- | --- |
| `SESSION_TOKEN_PREFIX`, `API_TOKEN_PREFIX` | `ts_` and `tk_`, the prefixes of a session token and of an API token. |
| `SESSION_JWT_TYPE`, `ACCESS_TOKEN_TYPE` | `JWT` and `at+jwt`, the header `typ` of a session JWT and of an OAuth access token. |
| `DEFAULT_COOKIE_NAME` | `__Host-tempo_session`, the session cookie name when the config sets no `cookieName`. |
| `LEGACY_COOKIE_NAME` | The session cookie name before plan 12b. Core reads it for one release when `cookieName` is the default. |
| `sessionCookieNames`, `SessionCookieNames` | The cookie names of a `cookieName` setting, and their type. The old name is read only with the default name. |
| `readSessionToken` | The session token of a request: the cookie, then the bearer header. |
| `readBearer` | The value of `Authorization: Bearer <value>`, or null. |
| `readDpopToken` | The value of `Authorization: DPoP <token>`, or null (RFC 9449 section 7.1). |
| `JWS_RE`, `decodeJws`, `DecodedJws` | The shape of a compact JWS, and its parts with no check. |
| `verifyJws`, `PublicJwk`, `JwsAlg` | The signature check on Web Crypto, for EdDSA, ES256, and RS256. The header must name the alg and the kid of the key. |
| `JWS_ALGS`, `isPublicJwk`, `JWK_PRIVATE_MEMBERS` | The three values of `jwtMint.alg`, and the check of one public signing key: its members fit its alg, and it holds no private member. The private member names of RFC 7518. |
| `JWKS_RETIRED_MAX` | The retired keys that the key set lists at most. |
| `checkDpopProof`, `DpopCheckInput`, `DpopCheck`, `DpopBinding` | The checks of a DPoP proof of RFC 9449 section 4.3, with no store. The caller spends the `jti` in its own replay store. |
| `DPOP_TYP` | `dpop+jwt`, the header `typ` of a DPoP proof. |
| `DPOP_WINDOW_SECONDS` | The window of a proof's `iat`: 60 seconds by default, from 10 to 300. Core's `oauth.dpop.windowSeconds` and `@authtempo/verify` read it. |
| `FOREIGN_ALGS`, `ForeignAlg` | The algs of a key that a client sends: `EdDSA`, `Ed25519`, `ES256`, `RS256`, and `PS256`. |
| `isResourceUrl`, `resourceOf` | The rule of an `oauth.resources` entry, and the entry that a request URL falls under. |

## The operator secret entry

`@authtempo/core/operator-secret` holds the one rule of the operator secret and the limits of the operator routes. Core and the CLI read each of them.

| Export | What it is |
| --- | --- |
| `OPERATOR_SECRET` | The form of the operator secret: 32 to 512 visible ASCII characters. |
| `isOperatorSecret` | True when a value has the form of an operator secret. |
| `OPERATOR_PER_IP` | The limit of `POST /operator/keys/rotate`: 5 calls per IP per hour. |
| `OPERATOR_SECRETS_PER_IP` | The shared limit of the secret routes and the info route: 120 calls per IP per hour. |
| `OPERATOR_USERS_PER_IP` | The limit of every secret call to the user, session, and audit routes of plan 12f: 600 calls per IP per hour. |

## The secrets entry

`@authtempo/core/secrets` holds the rules of the app secret, outside the main entry. `authtempo secret` reads them, so it refuses a value that `createAuth` would warn on.

| Export | What it is |
| --- | --- |
| `entropyBits` | The entropy estimate of a secret value, in bits. |
| `ENTROPY_WARN_BITS` | The estimate under which `createAuth` warns: 120 bits. |
| `ENTROPY_REFUSE_BITS` | The estimate under which `createAuth` refuses the value: 100 bits. |
| `SECRET_VERSION_MAX` | The largest secret version: 999999. |
| `REWRAP_LIMIT` | The row limit of one rewrap call: 100 by default, at most 1000. |

## Next

- [Routes](/docs/reference/routes/)
- [Configuration](/docs/reference/config/)
- [The storage port](/docs/concepts/storage-port/)
