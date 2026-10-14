---
title: The API reference
description: The auth object that createAuth answers, its in-process api, and every export of @authtempo/core.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 5
  - packages/core/src/create-auth.ts
  - packages/core/src/index.ts
---

**For:** a developer who calls core from server code, or looks for an export of `@authtempo/core`.

**What it does:** this page lists the members of the auth object and every export of the core entry. The export check holds this page to `packages/core/src/index.ts`.

## Before you start

- Read [Configuration](/docs/reference/config/) for the input of `createAuth`.

## The auth object

`createAuth(config)` answers an `Auth`. It throws `ConfigError` for a config that breaks a rule.

| Member | What it does |
| --- | --- |
| `handle(request)` | Serves the routes under `basePath`. Mount it for each path that starts with `basePath`. |
| `session(request)` | Answers the `ResolvedSession` of the cookie or the `ts_` bearer token, or null. A `tk_` token answers null. |
| `caller(request)` | Answers a `Caller`: a session, an API token, or an OAuth access token under its resource, or null. |
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
| Social sign-in | `startSocial`, `completeSocial` |
| Passkeys | `passkeyRegistrationOptions`, `verifyPasskeyRegistration`, `passkeyAuthenticationOptions`, `verifyPasskeyAuthentication`, `listPasskeys`, `deletePasskey` |
| Handoff | `startHandoff`, `continueHandoff`, `redeemHandoff` |
| Organizations | `createOrganization`, `listOrganizations`, `updateOrganization`, `deleteOrganization`, `listMembers`, `addMember`, `updateMemberRole`, `removeMember`, `inviteMember`, `listInvitations`, `revokeInvitation`, `acceptInvitation`, `declineInvitation` |
| `api.tokens` | `create`, `list`, `revoke`, `current` |
| `api.password` | `signUp`, `signIn`, `verify`, `verifyEmail`, `resendVerification`, `requestReset`, `reset`, `change`; present when `password` is set |
| `api.emailOtp` | `request`, `verify`, `requestReset`, `reset`; present unless `emailOtp` is `false` |
| `api.totp` | `setup`, `enable`, `verify`, `disable`, `disableWithCode`, `regenerateBackupCodes`, `regenerateBackupCodesWithCode`, `status`, `uri`, `revokeTrustedDevices`; present when the second factor is on. `disable` turns every method off |
| `api.jwt` | `mint`, `verify`, `rotate`, `jwks`, `sessionLive`; present unless `jwtMint` is `false` |
| `api.oauth` | `grants`, `revoke`; present when `oauth` is set |
| `api.secrets` | `status`, `rewrap`; present in every deployment, in process only. `status()` answers, for each version of the app secret, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, and `emailCodes` (live codes only). A version that a row names and the config lacks has `configured: false`. `status` reads every row of the TOTP, second factor, signing key, and code tables: one query per 1000 rows of each table. `rewrap({ limit, after })` reseals up to `limit` (1 to 1000, default 100) TOTP secrets and signing keys under the current version, and answers `{ resealed, failed, skipped, more, next }`. Pass `next` as `after` until `next` is `null` |

## Functions

| Export | What it does |
| --- | --- |
| `createAuth` | Makes the auth object from a config. |
| `createMemoryAdapter` | A storage adapter in memory, for tests and examples. |
| `createMemoryLimiter` | A limiter in memory, per isolate, for tests. It is the default. |
| `createPbkdf2PasswordHash` | The default password hash: PBKDF2-HMAC-SHA256, 100000 iterations. |
| `createJoseJwtSeam` | The default JWT seam, on jose. |
| `createSimpleWebAuthnSeam` | The default WebAuthn seam, on @simplewebauthn/server. |
| `createDeriveGate`, `deriveGate` | A gate that lets at most two legacy password derives run at once per isolate, and the shared gate. |
| `hookRefusal` | Makes the error that a before hook throws to refuse a flow with a message. |
| `systemClock` | The clock of the system. |
| `schema` | The models and the fields of the storage port. |
| `defaultConfirmPage`, `defaultSignInPage`, `defaultHandoffConfirmPage`, `defaultResetPage`, `defaultPasswordVerifyPage`, `defaultTotpPage`, `defaultConsentPage` | The default pages. [Replace the default pages](/docs/guides/pages/) tells how to replace one. |
| `defaultEmailOtpMail`, `defaultResetOtpMail`, `defaultSecondFactorMail` | The default mails of the email codes. `defaultSecondFactorMail` is the mail of a second-factor email code. |
| `defaultExistingAccountMail` | The default mail to a known address at a uniform sign-up. `password.existingAccountMail` replaces it. |
| `limiterKey` | Joins a key, the seconds, and the maximum into the stored key of the owned limiters. |
| `normalizeEmail`, `normalizeSlug` | The address rule and the slug rule of core. |
| `validOrganizationName`, `validUserName` | The name rules of core. |
| `rankOf` | The rank of a role string in a rank table. |
| `readSessionToken` | Reads the session token of a request, from the cookie and then the bearer header. |
| `isAppScheme`, `isGithubSubject` | The app scheme rule, and the rule of a GitHub subject. |
| `newId` | Makes a row id. |
| `checkCaptcha` | The captcha check of one flow, after its limits. It answers null when the flow goes on. |

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
| The auth object | `Auth`, `AuthApi`, `Caller`, `Result`, `Awaitable`, `PublicSession`, `ResolvedSession`, `ResolvedApiToken`, `SweepResult`, `Clock` |
| Config | `AuthConfig`, `SecretVersion`, `Keyring`, `AppleConfig`, `GoogleConfig`, `GitHubConfig`, `LinkedInConfig`, `OidcEntry`, `OidcEndpoints`, `OAuth2Entry`, `OrganizationsConfig`, `OrganizationLimits`, `PasswordConfig`, `LegacyVerifyConfig`, `EmailOtpConfig`, `TotpConfig`, `TotpGateConfig`, `JwtMintConfig`, `OAuthConfig`, `OperatorConfig`, `HooksConfig`, `CaptchaConfig` |
| Ports and seams | `StorageAdapter`, `LimiterPort`, `LimitWindow`, `MailPort`, `MailMessage`, `PasswordHashSeam`, `JwtSeam`, `WebAuthnSeam`, `DeriveGate`, `SignES256Input`, `VerifyIdTokenInput`, `JwsAlg`, `PublicJwk` |
| Storage | `ModelName`, `Models`, `Where`, `Op`, `Sort`, `FindManyOptions`, `UserRow`, `IdentityRow`, `SessionRow`, `VerificationRow`, `PasskeyRow`, `PasswordRow`, `ApiTokenRow`, `OrganizationRow`, `MemberRow`, `InvitationRow`, `TotpRow`, `TrustedDeviceRow`, `SecondFactorRow`, `SecondFactorMethod`, `JwkRow`, `OAuthClientRow`, `OAuthConsentRow`, `OAuthTokenRow` |
| Errors | `ErrorCode`, `OAuthErrorCode` |
| Pages and mails | `ConfirmPageInput`, `SignInPageInput`, `HandoffConfirmPageInput`, `ResetPageInput`, `PasswordVerifyPageInput`, `TotpChallengePageInput`, `ConsentPageInput`, `EmailOtpMailInput`, `ExistingAccountMailInput` |
| Magic link and social | `MagicLinkRequest`, `MagicLinkVerify`, `SocialStart`, `SocialStarted`, `SocialComplete`, `SocialProfile`, `SocialProviderName` |
| Passkeys | `PasskeySummary`, `RegisteredPasskey`, `AuthenticatedPasskey`, `PublicKeyCredentialCreationOptionsJSON`, `PublicKeyCredentialRequestOptionsJSON`, `RegistrationResponseJSON`, `AuthenticationResponseJSON` |
| Handoff | `HandoffStart` |
| Passwords | `PasswordApi`, `PasswordSignUp`, `PasswordSignUpResult`, `PasswordSignUpPending`, `PasswordSignIn`, `PasswordSignInResult`, `PasswordSession`, `PasswordVerify`, `PasswordVerified`, `PasswordResend`, `PasswordResetRequest`, `PasswordReset`, `ResetResult`, `ResetChallenge`, `PasswordChange`, `PasswordReauth` |
| Email codes | `EmailOtpApi`, `EmailOtpRequest`, `EmailOtpVerify`, `EmailOtpReset`, `EmailOtpSession`, `ResolvedEmailOtp` |
| Second factor | `TotpApi`, `TotpSetup`, `TotpSetupInput`, `TotpStatus`, `TwoFactorPending`, `TwoFactorSession`, `TwoFactorVerify`, `ChallengeMethod`, `SignInChallenge`, `MethodEnabled`, `ChallengeView` |
| API tokens | `TokensApi`, `ApiTokenCreate`, `ApiTokenSummary` |
| App secrets | `SecretsApi`, `SecretsStatus`, `SecretsRewrap`, `SecretVersionCount` |
| JWT and OAuth | `JwtApi`, `MintedJwt`, `SessionJwtClaims`, `TokenAnswer`, `OAuthApi`, `OAuthAccess`, `OAuthGrantSummary` |
| Organizations | `OrganizationSummary`, `MemberSummary`, `InvitationSummary`, `OrganizationPatch`, `ProposedMember` |
| Captcha | `CaptchaPort`, `CaptchaPage`, `CaptchaFlow` |
| Hooks | `OrganizationHooks`, `OrganizationHookEvent`, `SessionHooks`, `SessionDraft`, `SessionPatch`, `SessionVia`, `SessionEndReason`, `MemberVia`, `RemoveVia` |

## The other entries

| Entry | What it exports |
| --- | --- |
| `@authtempo/core/errors` | The error tables alone, for a client bundle. |
| `@authtempo/core/conformance` | `runAdapterConformance`, the suite of every storage adapter. |
| `@authtempo/core/limiter-conformance` | The suite of every limiter. |
| `@authtempo/core/sql` | The SQL helpers that both adapters share. |
| `@authtempo/core/testing` | `SoftAuthenticator`, `totpCode`, `base32Decode`, `ROUTES`, the route list, and `TEST_SECRET`, the app secret of the tests. |

## Next

- [Routes](/docs/reference/routes/)
- [Configuration](/docs/reference/config/)
- [The storage port](/docs/concepts/storage-port/)
