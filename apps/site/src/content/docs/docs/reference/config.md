---
title: Configuration
description: Every key that createAuth accepts, with its type, its default, and the rule that construction checks.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 5
  - packages/core/src/config.ts
  - apps/site/scripts/lib/config-keys.ts
  - docs/superpowers/plans/2026-10-14-11g-openapi.md
  - docs/superpowers/plans/2026-10-14-12e-oauth-provider-v2.md "Task 2"
---

**For:** a developer who writes the config of `createAuth`, or reads an error of construction.

**What it does:** this page lists every key, one row for each. `createAuth` refuses a value that breaks a rule, with a `ConfigError` that names the key.

## Before you start

- Read [Choose your stack](/docs/start/) for `storage` and `limiter`.

## Top level

The keys of `createAuth(config)`. `baseURL`, `trustedOrigins`, `storage`, and `mail` are required, and `secret` or `secrets`.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `basePath` | string | `"/auth"` | Starts with `/` and does not end with `/`. |
| `baseURL` | string | required | The origin of the server that mounts `handle`: no path, no trailing slash. |
| `secret` | string | `secrets` | Version 1 of the app secret. At least 32 characters. When it is the current version, it needs an estimate of 100 bits or more. It keys the stored codes and seals the factor secrets and the signing keys. |
| `secrets` | list of `{ version, value }` | `[{ version: 1, value: secret }]` | The app secrets, the current version first. The current version seals and keys every new value. See [Secrets](/docs/operations/secrets/). |
| `secrets[].version` | number | required | An integer from 1 to 999999. A row from before version 9 of the schema reads as version 1. |
| `secrets[].value` | string | required | At least 32 characters. The first entry needs an estimate of 100 bits or more. An entry under 120 bits writes one warning line. |
| `appName` | string | the host of `baseURL` | 1 to 80 characters with no control character. It names the app in the pages and the mail subjects. |
| `trustedOrigins` | string list | required | Exact origins and app schemes. A `*` is refused. |
| `appURL` | string | `baseURL` | An exact origin that is `baseURL` or a member of `trustedOrigins`. Sign-ins land here. |
| `cookie` | object | `{ sameSite: "Lax" }` | See `cookie.sameSite`. |
| `storage` | `StorageAdapter` | required | An adapter that passes the conformance suite. |
| `mail` | `MailPort` | required | `{ send(message) }`. Core calls it once per mail. |
| `limiter` | `LimiterPort` | the memory limiter | The memory limiter counts per isolate and is for tests. Use the owned limiter of the adapter. |
| `clientIp` | function of the request | reads `cf-connecting-ip` | Answers the client IP, or null. Off Workers, read the header of your trusted proxy. |
| `clock` | `Clock` | the system clock | `{ now(): Date }`. Tests inject one. |
| `cookieName` | string | `"__Host-tempo_session"` | The session cookie. The binding cookie drops a `__Host-` or `__Secure-` prefix, takes `__Secure-`, and adds `_oauth`. With the default name, core moves the old `tempo_session` cookie for one release. |
| `session` | object | `{ ttlDays: 30, slidingRefreshDays: 7 }`, no `absoluteDays` | See the keys under Session. |
| `magicLink` | object | the defaults below | See the keys under Magic link. |
| `social` | object | no provider | See the keys under Social. |
| `jwt` | `JwtSeam` | jose 6.2.12 | The ID token verifier and the Apple secret signer. Tests inject a fake. |
| `passkey` | object | off | Passkeys are on when it is set. |
| `webauthn` | `WebAuthnSeam` | @simplewebauthn/server 14.0.3 | The WebAuthn ceremonies. Tests inject a fake. |
| `handoff` | object | off | The handoff is on when it is set. |
| `organizations` | object or `false` | off | `{}` turns organizations on with the defaults. |
| `signUp` | `"open"` \| `"invited"` \| `false` | `"open"` | Who may become a user. `"invited"` needs `organizations` and a pending invitation of the address. `false` lets nobody new in. |
| `password` | object | off | `{}` turns passwords on. With no key, the password routes answer 404. |
| `emailOtp` | object or `false` | on | `false` removes the code routes and `api.emailOtp`. |
| `totp` | object or `false` | on when `password` is set | `false` removes the routes and `api.totp`. An object without `password` is refused. |
| `jwtMint` | object or `false` | on | `false` removes `/jwks`, `/token`, `/token/live`, and `api.jwt`. The OAuth provider needs it. |
| `oauth` | object or `false` | off | On when `resources` is set. Refused without `jwtMint`. |
| `operator` | object or `false` | off | Turns on `GET /operator/secrets/status`, `POST /operator/secrets/rewrap`, `GET /operator/info`, and `POST /operator/keys/rotate`. `keys/rotate` needs `jwtMint`. |
| `openapi` | `boolean` | `false` | Serves `GET <basePath>/openapi.json`, the OpenAPI document of the routes that the config turns on. |
| `hooks` | object | no hook | The groups `organization`, `session`, `user`, and `identity`. Any other group is refused. |
| `account` | object | the defaults below | The settings page: the proof mails, the notices, the confirm page, and the delete. See the keys under Account. |

## Cookie

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `cookie.sameSite` | `"Lax"` or `"None"` | `"Lax"` | An app on another site needs `"None"`. Another value is refused. |

## Session

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `session.ttlDays` | number | 30 | The life of a session in days. |
| `session.slidingRefreshDays` | number | 7 | A session older than this moves its expiry forward when it is used. |
| `session.absoluteDays` | number | none | 1 to 365. A session ends this many days after it opened, whatever its sliding refresh. |
| `session.freshMinutes` | number | 1440 | The fresh window in minutes, 1 to 1440. A sensitive change needs a sign-in or a re-authentication within it. [Fresh sessions](/docs/concepts/fresh-sessions/) tells which changes. |
| `session.deferRefresh` | boolean | `false` | With `true`, a GET request writes no session row, and `POST /session/refresh` slides the expiry. `GET /session` answers `needsRefresh`. Use it when a GET reads from a replica. Off by default: a client that never posts the refresh lets an active session end at its old expiry. |

## Magic link

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `magicLink.ttlMinutes` | number | 15 | The life of a link in minutes. |
| `magicLink.linkBuilder` | function of the token and `next` | `<baseURL><basePath>/magic-link/verify?token=<token>` | The link in the mail. It must open the verify route with the token. |
| `magicLink.confirmPage` | function of `ConfirmPageInput` | `defaultConfirmPage` | Answers the markup of the confirm page. |

## Social

Each provider adds a start route and a callback route. A field of a preset must be a string that is not empty.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `social.google` | `GoogleConfig` | none | Google sign-in. |
| `social.apple` | `AppleConfig` | none | Apple sign-in. |
| `social.github` | `GitHubConfig` | none | The GitHub preset, with the scope `read:user user:email`. |
| `social.linkedin` | `LinkedInConfig` | none | The LinkedIn preset, on the user info endpoint, with the scope `openid profile email`. |
| `social.oidc` | `OidcEntry` list | empty | OpenID Connect providers. |
| `social.oauth2` | `OAuth2Entry` list | empty | OAuth 2.0 providers that issue no ID token. |
| `social.fetch` | fetch | the global fetch | The fetch of every provider call. Tests inject one. |
| `social.google.clientId` | string | required | The client id of the Google OAuth client. |
| `social.google.clientSecret` | string | required | Core sends it in the token request body. |
| `social.apple.clientId` | string | required | The Services ID, such as `com.example.web`. |
| `social.apple.teamId` | string | required | The team id of the Apple developer account. |
| `social.apple.keyId` | string | required | The id of the Sign in with Apple key. |
| `social.apple.privateKey` | string | required | The PKCS#8 PEM of the key. Core signs a client secret of five minutes for each exchange. |
| `social.github.clientId` | string | required | The client id of the GitHub OAuth app. |
| `social.github.clientSecret` | string | required | The client secret of the GitHub OAuth app. |
| `social.linkedin.clientId` | string | required | The client id of the LinkedIn app. |
| `social.linkedin.clientSecret` | string | required | The client secret of the LinkedIn app. |
| `social.oidc[].name` | string | required | `^[a-z][a-z0-9-]{0,31}$`, unique in both lists, not a preset, `email`, or `credential`. |
| `social.oidc[].label` | string | required | The button text: 1 to 80 characters with no control character. |
| `social.oidc[].issuer` | string | required | An `https:` URL with no query, fragment, or credentials. A path is allowed. |
| `social.oidc[].clientId` | string | required | The client id at the provider. |
| `social.oidc[].clientSecret` | string | required | The client secret at the provider. |
| `social.oidc[].scope` | string | `"openid email profile"` | Must hold `openid`. No control character. |
| `social.oidc[].endpoints` | object | none | With it, core never reads the discovery document. |
| `social.oidc[].endpoints.authorizeUrl` | string | required in `endpoints` | An `https:` URL. |
| `social.oidc[].endpoints.tokenUrl` | string | required in `endpoints` | An `https:` URL. |
| `social.oidc[].endpoints.jwksUrl` | string | required in `endpoints` | An `https:` URL. |
| `social.oauth2[].name` | string | required | The rule of `social.oidc[].name`. |
| `social.oauth2[].label` | string | required | The rule of `social.oidc[].label`. |
| `social.oauth2[].authorizeUrl` | string | required | An `https:` URL. |
| `social.oauth2[].tokenUrl` | string | required | An `https:` URL. |
| `social.oauth2[].clientId` | string | required | The client id at the provider. |
| `social.oauth2[].clientSecret` | string | required | The client secret at the provider. |
| `social.oauth2[].scope` | string | required | Not empty. No control character. |
| `social.oauth2[].authorizeParams` | string map | none | Extra authorize parameters. A key that core sets is refused: `client_id`, `redirect_uri`, `response_type`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`. |
| `social.oauth2[].userinfo` | function of the access token and a fetch | required | Answers a `SocialProfile`. It stops at 10 seconds. |

## Passkeys

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `passkey.rpID` | string | required | The registrable domain that the passkeys bind to. |
| `passkey.rpName` | string | required | The name that the device shows. Not empty. |
| `passkey.origins` | string list | required | Exact origins on `rpID`, not empty. Each must be `baseURL` or in `trustedOrigins`. |

## Handoff

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `handoff.schemes` | string list | required | App schemes such as `myapp://`, not empty. `http://` and `https://` are refused. |
| `handoff.devRedirectPattern` | `RegExp` | none | Development only. The `g` and `y` flags are refused. An `http` or `https` match must be on a loopback host. |
| `handoff.signInPage` | function of `SignInPageInput` | `defaultSignInPage` | Answers the markup of the sign-in page. It must put the nonce on its script tag. |
| `handoff.confirmPage` | function of `HandoffConfirmPageInput` | `defaultHandoffConfirmPage` | Answers the markup of the continue page. |

## Organizations

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `organizations.ranks` | map of role to number | `{ viewer: 1, member: 2, admin: 3, owner: 4 }` | Positive integers. Must name `owner`. A role name holds no comma. |
| `organizations.reservedSlugs` | string list | `admin`, `api`, `auth`, `internal`, `operator`, `ops`, `platform`, `system`, `www` | Each entry must be a slug. |
| `organizations.platformOrganization` | string | none | A slug. Core reserves it. |
| `organizations.platformRole` | string | none | A role of `ranks`. It needs `platformOrganization`. |
| `organizations.invitationTtlDays` | number | 7 | A positive integer. |
| `organizations.invitationLinkBuilder` | function of the token and the organization | `<appURL>/?invitation=<token>` | The link in the invitation mail. |
| `organizations.limits` | object | no limit | See the three limits. |
| `organizations.limits.perUser` | number | none | A positive integer. Create answers `organization_limit` at it. |
| `organizations.limits.membersPerOrganization` | number | none | A positive integer. Add and accept answer `member_limit` at it. |
| `organizations.limits.pendingInvitationsPerOrganization` | number | none | A positive integer. Invite answers `invitation_limit` at it. |

## Passwords

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `password.hash` | `PasswordHashSeam` | `createPbkdf2PasswordHash()` | PBKDF2-HMAC-SHA256, 100000 iterations. |
| `password.minLength` | number | 8 | An integer from 8 to 128, in code points. |
| `password.breachCheck` | async function of the password | none | `true` refuses the password with `password_breached`. `"unavailable"` refuses it with 503 `breach_check_unavailable`: the check fails closed. A throw answers 500. Core sets no deadline on the function, so an app's own function sets its own. `@authtempo/breach-check` answers it, with a default deadline of 2000 ms. |
| `password.resetTtlMinutes` | number | 15 | An integer from 1 to 1440. |
| `password.resetPage` | function of `ResetPageInput` | `defaultResetPage` | Answers the markup of the reset form. |
| `password.legacyVerify` | `LegacyVerifyConfig` | none | The old system's check, for users with `LEGACY_VERIFY_HASH`. |
| `password.legacyVerify.verify` | async function of the address, the password, and a signal | required in `legacyVerify` | Only `true` is a match. |
| `password.legacyVerify.timeoutMs` | number | 5000 | An integer from 100 to 30000. Every failed sign-in waits this long. |
| `password.requireVerified` | boolean | `false` | True refuses the right password of an unverified address with `email_unverified` and mails a new link. A sign-up then opens no session. The default keeps the sign-in of an unverified user that core allows since plan 8. |
| `password.uniformSignUp` | boolean | `true` | Every sign-up answers `{ sent: true }` with no session, and a known address gets a mail (ASVS 5.0.0 6.3.8). False keeps a session at sign-up and `email_taken`. `requireVerified` changes only the answer of `false`. |
| `password.existingAccountMail` | function of `{ email, appName, appURL }` to a mail | `defaultExistingAccountMail` | The mail to a known address at a uniform sign-up. Core sends it to the address, whatever `to` it answers. |

## Email codes

Another key of `emailOtp` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `emailOtp.ttlMinutes` | number | 10 | An integer from 1 to 60. |
| `emailOtp.length` | 6 or 8 | 6 | The digits of a code. |
| `emailOtp.maxAttempts` | number | 5 | An integer from 3 to 10. |
| `emailOtp.mail` | function of `EmailOtpMailInput` | `defaultEmailOtpMail` | Answers the sign-in code mail. Core sends it to the code's address. |
| `emailOtp.resetMail` | function of `EmailOtpMailInput` | `defaultResetOtpMail` | Answers the reset code mail, with the same rule. |

## Second factor

Another key of `totp` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `totp.issuer` | string | `appName`, else the host of `baseURL` with no port | 1 to 80 characters, no control character, no colon. A default with a colon is refused. |
| `totp.backupCodes` | number | 10 | An integer from 5 to 20. |
| `totp.backupCodeLength` | number | 23 | An integer from 23 to 32. A code of 23 characters holds 113.9 bits, above the 112 bits of ASVS 5.0 6.5.2. |
| `totp.trustDays` | number | 30 | An integer from 1 to 365. |
| `totp.trustCookieName` | string | `"tempo_totp_trust"` | 1 to 64 letters, digits, `.`, `_`, or `-`, and not `cookieName` or `tempo_session`. |
| `totp.challengePage` | function of `TotpChallengePageInput` | `defaultTotpPage` | Answers the markup of the challenge form. |
| `totp.gate` | object | all three on | The second factor's gate on the sign-in methods other than the password. Another key is refused. The handoff has no key: it continues a browser session that passed the gate. |
| `totp.gate.magicLink` | boolean | `true` | `false` lets the magic link open a session with no second factor. |
| `totp.gate.emailOtp` | boolean | `true` | `false` lets the email code sign-in open a session with no second factor. |
| `totp.gate.social` | boolean | `true` | `false` lets every social provider open a session with no second factor. |
| `totp.emailMail` | function of `EmailOtpMailInput` | `defaultSecondFactorMail` | Answers the mail of a second-factor email code. Core sends it to the user's address. |

## JWT minting

Another key of `jwtMint` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `jwtMint.alg` | `"EdDSA"`, `"ES256"`, or `"RS256"` | `"EdDSA"` | Every JWT of the deployment signs with this alg. A change retires the signing key at the next signature. |
| `jwtMint.audience` | string or string list | `[baseURL]` | 1 to 10 strings of 1 to 2048 characters with no control character, and none an `oauth.resources` entry. |
| `jwtMint.ttlMinutes` | number | 15 | An integer from 1 to 60. |
| `jwtMint.claims` | function of the user and the session | none | Answers an object of claims. Core sets the reserved claims itself. |
| `jwtMint.rotateEvery` | number of days | none: no timer | A whole number from 1 to 365. The first signature with a key this old makes a new key. A JWKS read never rotates. |

`jwtMint.alg: "RS256"` costs more CPU than EdDSA or ES256. One RSA key generation took 20 to 129 ms of wall time in local workerd. One RS256 signature took less than 1 ms. These are wall times on a loaded machine, measured on 2026-10-19.

On Workers, every RS256 key generation runs inside a Worker invocation, a request or a scheduled event. The first signature with no key makes a key. A `rotateEvery` rotation, a change of `jwtMint.alg`, and `api.jwt.rotate()` make a key too. `authtempo keys rotate` calls `POST <basePath>/operator/keys/rotate`, which is a Worker request. A new app `secret` opens no old key: the key retires, and the next signature makes a key. Workers Free allows 10 ms of CPU per invocation, so it can refuse each of these.

## OAuth provider

Another key of `oauth` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `oauth.resources` | string list | required | 1 to 20 distinct absolute `http` or `https` URLs with no query, fragment, or credentials. |
| `oauth.scopes` | map of scope to text | the built-in scopes `openid`, `profile`, `email`, and `offline_access` | A built-in name is refused. A scope is 1 to 64 printable ASCII characters with no space, quote, or backslash. Its text is 1 to 200 characters. |
| `oauth.registration` | object | `{ dynamic: false, cimd: true }` | See the three registration keys. Both `dynamic` and `cimd` may be off: `api.oauth.clients.create` is then the way in. |
| `oauth.fetch` | fetch | none | Required while `registration.cimd` is on. It must refuse private addresses. |
| `oauth.consentPage` | function of `ConsentPageInput` | `defaultConsentPage` | Answers the markup of the consent page. |
| `oauth.accessTtlMinutes` | number | `jwtMint.ttlMinutes` | An integer from 1 to 60. |
| `oauth.refreshTtlDays` | number | 30 | An integer from 1 to 365. |
| `oauth.codeTtlMinutes` | number | 5 | An integer from 1 to 10. |
| `oauth.introspection` | map of client id to resource list | none | The resources whose tokens each client of `POST /oauth/introspect` may see (RFC 7662 section 4). Each resource is an entry of `oauth.resources`, or the config throws. Without the map, every introspection client sees the one resource when `oauth.resources` has one entry. With more entries, it sees none. An access token of a resource outside the caller's list answers `{ active: false }`. The map does not apply to a refresh token: only its own client gets an answer for it. |
| `oauth.dpop` | object | `{ algs: all five, windowSeconds: 60 }` | See the two DPoP keys. At `/oauth/token` and `/oauth/userinfo`, the `htu` of a proof must be `baseURL` plus `basePath` plus the route path. `auth.caller` compares `htu` with the request URL. So a binding behind a proxy must give core the public URL of the request. |
| `oauth.dpop.algs` | list of alg names | all five | The algs of a DPoP proof (RFC 9449): distinct values of `EdDSA`, `Ed25519`, `ES256`, `RS256`, and `PS256`. `none` and a MAC are never accepted. DPoP has no off switch: a client that sends no proof gets a Bearer token as before. |
| `oauth.dpop.windowSeconds` | number | 60 | An integer from 10 to 300. A proof's `iat` may be this far from now, in either direction. RFC 9449 section 11.1 asks for a short window, and 60 s covers a client clock that drifts. The replay row of each proof lives twice the window in the `verification` table. |
| `oauth.signInURL` | string | none: core's sign-in page | The app's own sign-in route for the authorize step. An `https` URL on the origin of `baseURL`, `appURL`, or a `trustedOrigins` entry, or a path on `appURL` that starts with `/`. A query, a fragment, a user name, or another origin throws. The browser comes to `<signInURL>?request_id=oq_…`. After the sign-in, send it to `continueAuthorizeURL` of `@authtempo/client/oauth`. The held request is the only state, so the parameter opens no redirect. |
| `oauth.registration.dynamic` | boolean | false | Serves `POST /oauth/register` of RFC 7591. Off by default since plan 12e: MCP 2026-07-28 calls dynamic registration deprecated. |
| `oauth.registration.initialAccessTokenHash` | string | none | The SHA-256 of an initial access token, as 64 lowercase hex characters. While it is set, `POST /oauth/register` needs `Authorization: Bearer <token>`, and a miss answers 401 `invalid_token`. Core stores the hash and never the token. With `dynamic` off, the config throws: no route reads the token. |
| `oauth.registration.cimd` | boolean | true | Accepts a client id that is the https URL of its metadata document. |

## Operator

Another key of `operator` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `operator.secretHash` | string | required | The SHA-256 of the operator secret as 64 lowercase hex characters. Core stores no secret. The secret must be 32 to 512 visible ASCII characters, and any other secret answers 401 with no reason. |

## Hooks

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `hooks.organization` | `OrganizationHooks` | none | Needs `organizations`. A name that is no hook point is refused. |
| `hooks.session` | `SessionHooks` | none | `beforeCreate`, `afterCreate`, and `afterEnd`. |
| `hooks.user` | `UserHooks` | none | `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeVerify`, and `afterVerify`. [Run your code at a flow point](/docs/guides/hooks/) gives the order. |
| `hooks.identity` | `IdentityHooks` | none | `beforeLink`, `afterLink`, `beforeUnlink`, and `afterUnlink`. The `email` identity fires none. |

## Captcha

The token comes in the header `x-captcha-response`. Core checks it after the per-IP limit of the flow. The check runs before every per-email limit, the password policy, the breach check, and the first read of a user. So a request with no token spends no per-email limit of an address, and costs no breach call. An in-process `api` call with no `captchaToken` skips the check. An app that proxies a browser request through `api` must pass the browser's token as `captchaToken`; without it, the check does not run.
Core serves its own sign-in page with `handoff` or `oauth`, unless `handoff.signInPage` replaces it. Then `captcha.port.page` is required when a gated flow is on that page. The page has the magic link form, and the password forms only with `password`. It has no email code form. Without the widget, the page sends no token, and every gated flow on it answers `captcha_required`.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `captcha` | object | off | Turns the check on for the flows in `captcha.flows`. |
| `captcha.port` | `CaptchaPort` | required | An object with `verify`. `@authtempo/captcha-turnstile` gives one. Its optional `page` puts the widget on core's sign-in page: `scriptSrc` is an https URL, `responseField` is 1 to 64 letters, digits, `_`, or `-`, and `cspSources` holds https origins with no path. |
| `captcha.flows` | `CaptchaFlow[]` | `password-sign-up`, `magic-link-request`, `email-otp-request`, `password-reset-request` | 1 or more distinct flows. `password-sign-in` is the fifth flow, and it is off by default. `password-reset-request` covers the reset link and the reset code. |
| `captcha.onUnavailable` | `"allow"` \| `"refuse"` | `"allow"` | What happens when the captcha gives no answer. `"allow"` writes one log line and goes on: the limits still bound the flow. `"refuse"` answers 503 `captcha_unavailable`. |

## Account

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `account.mail` | function of `AccountMailInput` | `defaultAccountMail` | Answers the proof mails: the re-authentication code, the change-of-address link and code, and the note to a taken address. Core sends each to its address. |
| `account.notices` | object or `false` | on | The notice mails after a change of a way in. `false` turns them off. |
| `account.notices.mail` | function of `NoticeMailInput` | `defaultNoticeMail` | Answers a notice. Core sends it to the input's address. |
| `account.confirmPage` | function of `EmailChangePageInput` | `defaultEmailChangePage` | Answers the markup of the page a change-of-address link opens. It must post `token` to `action`. Core sets the headers. |
| `account.delete` | boolean | `true` | Turns on `POST /user/delete` and the two routes of its mailed confirm. The right to delete the account is the person's, so it is on by default. `false` removes the routes. |
| `account.deleteConfirm` | `AccountDeleteConfirmConfig` or `false` | `false` | A mailed link before the delete. The default is off: the fresh session already proves the person (ASVS 5.0.0 7.5.1), and Better Auth deletes at once unless an app sets `sendDeleteAccountVerification`. The link adds a proof of the mailbox, for an app whose sessions live on shared devices. `{}` turns it on. |
| `account.deleteConfirm.ttlMinutes` | number | 60 | An integer from 5 to 1440. A delete is not undone, and a short window lowers the risk of a link in an old mailbox. Better Auth's default is 24 hours. |

## Next

- [Routes](/docs/reference/routes/)
- [The API reference](/docs/reference/api/)
- [Secrets](/docs/operations/secrets/)
