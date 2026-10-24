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
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 2"
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
| `jwt` | `JwtSeam` | jose 6.2.12 | The ID token verifier and the Apple secret signer. Tests inject a fake. A seam must read the JWKS through `fetch` of `VerifyIdTokenInput` when the call gives one. An SSO sign-in gives the capped `sso.fetch`. |
| `passkey` | object | off | Passkeys are on when it is set. |
| `webauthn` | `WebAuthnSeam` | @simplewebauthn/server 14.0.3 | The WebAuthn ceremonies. Tests inject a fake. |
| `handoff` | object | off | The handoff is on when it is set. |
| `organizations` | object or `false` | off | `{}` turns organizations on with the defaults. |
| `tokens` | object | no window, no moved prefix | The limits of API tokens. Tokens are always on. |
| `signUp` | `"open"` \| `"invited"` \| `false` | `"open"` | Who may become a user. `"invited"` needs `organizations` and a pending invitation of the address. `false` lets nobody new in. |
| `password` | object | off | `{}` turns passwords on. With no key, the password routes answer 404. |
| `emailOtp` | object or `false` | on | `false` removes the code routes and `api.emailOtp`. |
| `phone` | object or `false` | off | The phone code by SMS. An object needs `sms` and `regions`, and a limiter whose `scope` is `"shared"`. |
| `totp` | object or `false` | on when `password` is set | `false` removes the routes and `api.totp`. An object without `password` is refused. |
| `jwtMint` | object or `false` | on | `false` removes `/jwks`, `/token`, `/token/live`, and `api.jwt`. The OAuth provider needs it. |
| `oauth` | object or `false` | off | On when `resources` is set. Refused without `jwtMint`. |
| `operator` | object or `false` | off | Turns on `GET /operator/secrets/status`, `POST /operator/secrets/rewrap`, `GET /operator/info`, and `POST /operator/keys/rotate`. `keys/rotate` needs `jwtMint`. Set `operator.secretHash` or `operator.secrets`, not both. |
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
| `social.microsoft` | `MicrosoftConfig` | none | The Microsoft Entra ID preset, with the scope `openid profile email`. The subject is `oid`. |
| `social.discord` | `DiscordConfig` | none | The Discord preset, with the scope `identify email`. |
| `social.gitlab` | `GitLabConfig` | none | The GitLab preset, with the scope `read_user`. A GitLab address is never verified. |
| `social.slack` | `SlackConfig` | none | The Slack preset, on the user info endpoint, with the scope `openid profile email`. The subject is `<team_id>:<user_id>`, because Slack's user object page (read 2026-10-24) says a user id is unique only in its workspace. A user info answer with no team id answers `oauth_failed`. A token answer without `ok: true` answers `oauth_failed`. |
| `social.twitter` | `TwitterConfig` | none | The X preset, with the scope `users.read tweet.read users.email`. Core sends the client secret to the token endpoint as HTTP Basic. Only `confirmed_email` gives an address, and it counts as verified. |
| `social.facebook` | `FacebookConfig` | none | The Facebook preset on Graph API `v26.0`, with the scope `email public_profile`. A Facebook address is never verified. |
| `social.oidc` | `OidcEntry` list | empty | OpenID Connect providers. |
| `social.oauth2` | `OAuth2Entry` list | empty | OAuth 2.0 providers that issue no ID token. |
| `social.fetch` | fetch | the global fetch | The fetch of every provider call. Tests inject one. |
| `social.stateData` | object or `false` | `false` | The app payload through the social flow. The start and the link start take `data`, and the hooks get `stateData`. [Carry app data through a social sign-in](/docs/guides/social-state-data/). |
| `social.stateData.maxBytes` | number | `1024` | 1 to 1024. The most UTF-8 bytes of the JSON of `data`. |
| `social.google.clientId` | string | required | The client id of the Google OAuth client. |
| `social.google.clientSecret` | string | required | Core sends it in the token request body. |
| `social.google.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.apple.clientId` | string | required | The Services ID, such as `com.example.web`. |
| `social.apple.teamId` | string | required | The team id of the Apple developer account. |
| `social.apple.keyId` | string | required | The id of the Sign in with Apple key. |
| `social.apple.privateKey` | string | required | The PKCS#8 PEM of the key. Core signs a client secret of five minutes for each exchange. |
| `social.apple.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.github.clientId` | string | required | The client id of the GitHub OAuth app. |
| `social.github.clientSecret` | string | required | The client secret of the GitHub OAuth app. |
| `social.github.redirectURI` | string | `<baseURL><basePath>/social/github/callback` | The callback URL that the provider has registered, for an app that cannot register the default. An `https:` URL in the normal form, on the origin of `baseURL`, with a path under `basePath`, and no query or fragment. Not the path of a route of core, nor of another provider. Core sends it as `redirect_uri` and serves its path as the callback. Each preset and list entry takes this key. |
| `social.linkedin.clientId` | string | required | The client id of the LinkedIn app. |
| `social.linkedin.clientSecret` | string | required | The client secret of the LinkedIn app. |
| `social.linkedin.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.microsoft.clientId` | string | required | The application (client) id of the Entra ID app registration. |
| `social.microsoft.clientSecret` | string | required | The client secret of the app registration. |
| `social.microsoft.tenant` | string | required | `common`, `organizations`, `consumers`, or a tenant GUID. A token must name its own tenant in `iss`. `organizations` refuses a personal account, and `consumers` takes only a personal account. An address is verified only with the optional claim `xms_edov: true`. |
| `social.microsoft.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.discord.clientId` | string | required | The client id of the Discord app. |
| `social.discord.clientSecret` | string | required | The client secret of the Discord app. |
| `social.discord.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.gitlab.clientId` | string | required | The application id of the GitLab app. |
| `social.gitlab.clientSecret` | string | required | The secret of the GitLab app. |
| `social.gitlab.issuer` | string | `"https://gitlab.com"` | The `https:` origin of the GitLab instance, with no path and no trailing slash. No IP address, no local name, and not the host of `baseURL`. |
| `social.gitlab.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.slack.clientId` | string | required | The client id of the Slack app. |
| `social.slack.clientSecret` | string | required | The client secret of the Slack app. |
| `social.slack.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.twitter.clientId` | string | required | The OAuth 2.0 client id of the X app. |
| `social.twitter.clientSecret` | string | required | The OAuth 2.0 client secret of the X app, a confidential client. |
| `social.twitter.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.facebook.clientId` | string | required | The app id of the Meta app. |
| `social.facebook.clientSecret` | string | required | The app secret of the Meta app. |
| `social.facebook.redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
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
| `social.oidc[].redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |
| `social.oauth2[].name` | string | required | The rule of `social.oidc[].name`. |
| `social.oauth2[].label` | string | required | The rule of `social.oidc[].label`. |
| `social.oauth2[].authorizeUrl` | string | required | An `https:` URL. |
| `social.oauth2[].tokenUrl` | string | required | An `https:` URL. |
| `social.oauth2[].clientId` | string | required | The client id at the provider. |
| `social.oauth2[].clientSecret` | string | required | The client secret at the provider. |
| `social.oauth2[].scope` | string | required | Not empty. No control character. |
| `social.oauth2[].authorizeParams` | string map | none | Extra authorize parameters. A key that core sets is refused: `client_id`, `redirect_uri`, `response_type`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`. |
| `social.oauth2[].userinfo` | function of the access token and a fetch | required | Answers a `SocialProfile`. It stops at 10 seconds. |
| `social.oauth2[].redirectURI` | string | the default callback | The redirect override. See `social.github.redirectURI`. |

## Passkeys

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `passkey.rpID` | string | required | The registrable domain that the passkeys bind to. Write it in lowercase ASCII, with an internationalized domain in punycode, such as `xn--bcher-kva.example`. `createAuth` refuses another form and names the punycode form. |
| `passkey.rpName` | string | required | The name that the device shows. Not empty. |
| `passkey.origins` | string list | required | Exact origins on `rpID`, not empty. Each must be `baseURL` or in `trustedOrigins`. |
| `passkey.relatedOrigins` | boolean | `false` | With `true`, `auth.wellKnown` serves `/.well-known/webauthn` on the `rpID` host, and `origins` may hold at most five origins outside `rpID` (WebAuthn Level 3). |
| `passkey.hints` | object | none | The hints of each ceremony. |
| `passkey.hints.register` | hint list | none | `security-key`, `client-device`, or `hybrid`, each once, in order of preference, for the registration. |
| `passkey.hints.signIn` | hint list | none | The same, for the sign-in. |

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
| `organizations.ranks` | map of role to number | `{ viewer: 1, member: 2, admin: 3, owner: 4 }` | Positive integers. Must name `owner`. A role name holds no comma. Core derives the permissions of each role. Not with `roles`. |
| `organizations.roles` | map of role to `{ rank, permissions }` | none | Each rank a positive integer. Must name `owner`. A role name holds no comma. Each permission is a known resource and action. Not with `ranks`. |
| `organizations.statements` | map of resource to action list | none | The app's own resources beside the core ones. A core resource name, a bad name, an empty list, and a repeated action are refused. |
| `organizations.reservedSlugs` | string list | `admin`, `api`, `auth`, `internal`, `operator`, `ops`, `platform`, `system`, `www` | Each entry must be a slug. |
| `organizations.platformOrganization` | string | none | A slug. Core reserves it. |
| `organizations.platformRole` | string | none | A role of `ranks` or `roles`. It needs `platformOrganization`. |
| `organizations.invitationTtlDays` | number | 7 | A positive integer. |
| `organizations.invitationLinkBuilder` | function of the token and the organization | `<appURL>/?invitation=<token>` | The link in the invitation mail. |
| `organizations.limits` | object | no limit | See the five limits. |
| `organizations.dynamicRoles` | object | off | Turns on the roles that each organization stores. See [Dynamic roles](/docs/reference/routes/#dynamic-roles). |
| `organizations.dynamicRoles.maxPerOrganization` | number | 50 | An integer from 1 to 1000. A create at the limit answers `role_limit`. |
| `organizations.teams` | object | off | Turns on the teams inside each organization. See [Teams](/docs/reference/routes/#teams). |
| `organizations.teams.defaultTeam` | boolean | false | The create of an organization also creates one team named as the organization, with the creator in it. |
| `organizations.teams.keepLastTeam` | boolean | false | The delete of the last team of an organization answers `last_team`. |
| `organizations.limits.perUser` | number | none | A positive integer. Create answers `organization_limit` at it. |
| `organizations.limits.membersPerOrganization` | number | none | A positive integer. Add and accept answer `member_limit` at it. |
| `organizations.limits.pendingInvitationsPerOrganization` | number | none | A positive integer. Invite answers `invitation_limit` at it. |
| `organizations.limits.teamsPerOrganization` | number | none | A positive integer. A team create answers `team_limit` at it. |
| `organizations.limits.membersPerTeam` | number | none | A positive integer. A team member add and an accept answer `team_member_limit` at it. |

## API tokens

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `tokens.defaultRateLimit` | `{ seconds, max }` or `null` | `null` | The window of a new token that names none: `seconds` 1 to 86400, `max` 1 to 100000. A token from `POST /tokens` always gets it. Over the window, a token call answers `rate_limited`. |
| `tokens.movedPrefixes` | string list | none | The prefixes of keys that moved into core's token table, such as `laaa_`. Each matches `^[a-z][a-z0-9]{0,15}_$` and is no prefix that core issues. A key with such a prefix and no row answers `token_retired`. |

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

## Phone codes

Another key of `phone` is refused. Core makes each code, keys its hash, counts each guess, and counts every send against `dailyCap`. The SMS port only sends text.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `phone.sms` | `SmsPort` | required | An object with `send({ to, text })` that answers `"sent"` or `"unavailable"`. A throw counts as `"unavailable"`. |
| `phone.regions` | `string[]` | required, no default | 1 to 50 calling-code prefixes, such as `"+1"` or `"+44"`: a plus sign and 1 to 4 digits. A number outside every prefix gets no SMS. |
| `phone.signUp` | boolean | `false` | True lets a code to an unknown number make a user. |
| `phone.ttlMinutes` | number | 5 | An integer from 1 to 10. |
| `phone.length` | 6 or 8 | 6 | The digits of a code. |
| `phone.maxAttempts` | number | 3 | An integer from 3 to 10. |
| `phone.dailyCap` | number | 1000 | The codes of the deployment per 24 hours, an integer from 1 to 100000. A send over the cap makes no call to the port. The window is fixed: see [the limits](/docs/reference/limits/). |
| `phone.isolateLimiter` | `"allow"` | absent | Lets a limiter that counts per isolate build, for tests and local development. The cap is then per isolate. |
| `phone.message` | function of `{ code, appName, ttlMinutes }` to a string | `defaultPhoneMessage` | The text of the SMS. A throw counts as `"unavailable"`, as a throw of the port does. |

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
| `totp.gate.sso` | boolean | `true` | `false` lets every SSO connection open a session with no second factor. A connection's `mfa` list passes the gate when the provider asserts one of its values. |
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

On Workers, every RS256 key generation runs inside a Worker invocation, a request or a scheduled event. The first signature or the first key set read with no key makes a key. A `rotateEvery` rotation, a change of `jwtMint.alg`, and `api.jwt.rotate()` make a key too. `authtempo keys rotate` calls `POST <basePath>/operator/keys/rotate`, which is a Worker request. A new app `secret` opens no old key: the key retires, and the next signature makes a key. Workers Free allows 10 ms of CPU per invocation, so it can refuse each of these.

## OAuth provider

Another key of `oauth` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `oauth.resources` | string list | required | 1 to 20 distinct absolute `http` or `https` URLs with no query, fragment, or credentials. |
| `oauth.defaultResource` | string | none | One entry of `oauth.resources`, else the config throws. An authorize request, a `client_credentials` grant, or a device start with no `resource` takes this resource. Without the key, each of them answers `invalid_target`. An empty `resource` counts as none. A named `resource` always wins over the key. A code exchange and a refresh with no `resource` keep the resource of their grant either way. Set it only for a client that cannot send RFC 8707 `resource`, such as the OpenID conformance suite. |
| `oauth.scopes` | map of scope to text | the built-in scopes `openid`, `profile`, `email`, and `offline_access` | A built-in name is refused. A scope is 1 to 64 printable ASCII characters with no space, quote, or backslash. Its text is 1 to 200 characters. |
| `oauth.registration` | object | `{ dynamic: false, cimd: true }` | See the three registration keys. Both `dynamic` and `cimd` may be off: `api.oauth.clients.create` is then the way in. |
| `oauth.fetch` | fetch | none | Required while `registration.cimd` is on, and for a client with a back-channel sign-out URI. Core fetches documents and key sets through it, and posts each back-channel sign-out message through it. It must refuse private addresses for each of them: core cannot resolve a host name. Each sign-out with such a client can take up to 2 seconds more while the client does not answer. |
| `oauth.consentPage` | function of `ConsentPageInput` | `defaultConsentPage` | Answers the markup of the consent page. |
| `oauth.accessTtlMinutes` | number | `jwtMint.ttlMinutes` | An integer from 1 to 60. |
| `oauth.refreshTtlDays` | number | 30 | An integer from 1 to 365. |
| `oauth.codeTtlMinutes` | number | 5 | An integer from 1 to 10. |
| `oauth.introspection` | map of client id to resource list | none | The resources whose tokens each client of `POST /oauth/introspect` may see (RFC 7662 section 4). Each resource is an entry of `oauth.resources`, or the config throws. Without the map, every introspection client sees the one resource when `oauth.resources` has one entry. With more entries, it sees none. An access token of a resource outside the caller's list answers `{ active: false }`. The map does not apply to a refresh token: only its own client gets an answer for it. |
| `oauth.dpop` | object | `{ algs: all five, windowSeconds: 60 }` | See the two DPoP keys. At `/oauth/token` and `/oauth/userinfo`, the `htu` of a proof must be `baseURL` plus `basePath` plus the route path. `auth.caller` compares `htu` with the request URL. So a binding behind a proxy must give core the public URL of the request. |
| `oauth.dpop.algs` | list of alg names | all five | The algs of a DPoP proof (RFC 9449): distinct values of `EdDSA`, `Ed25519`, `ES256`, `RS256`, and `PS256`. `none` and a MAC are never accepted. DPoP has no off switch: a client that sends no proof gets a Bearer token as before. |
| `oauth.dpop.windowSeconds` | number | 60 | An integer from 10 to 300. A proof's `iat` may be this far from now, in either direction. RFC 9449 section 11.1 asks for a short window, and 60 s covers a client clock that drifts. The replay row of each proof lives twice the window in the `verification` table. |
| `oauth.signInURL` | string | none: core's sign-in page | The app's own sign-in route for the authorize step. An `https` URL on the origin of `baseURL`, `appURL`, or a `trustedOrigins` entry, or a path on `appURL` that starts with `/`. A query, a fragment, a user name, or another origin throws. The browser comes to `<signInURL>?request_id=oq_…`. After the sign-in, send it to `continueAuthorizeURL` of `@authtempo/client/oauth`. The route must ask for a new sign-in each time, also when the browser has a live session. Core never lets a session from before the request go on. A route that skips its form for a live session makes a redirect loop. The held request is the only state, so the parameter opens no redirect. |
| `oauth.refreshReuseSeconds` | number | 0 | An integer from 0 to 60; 0 is off. A spent refresh token that its own client presents again within this many seconds of its use answers a new child. The child of the first use is then spent. The client auth and the DPoP key check run first. The superseded child, presented later, deletes the family. A copy outside the window deletes the family at once. A copy inside the window gets an access token and a refresh token. Its holder can rotate that refresh token until the client's next refresh. That refresh deletes the family. So an attacker who holds a copy has this many seconds to act, and access until the client's next refresh plus at most `accessTtlMinutes`. RFC 9700 section 4.14.2 gives no grace period, so the default is off. |
| `oauth.device` | object or `false` | off | The device grant of RFC 8628. On with `{}`: core serves `POST /oauth/device_authorization`, `GET /oauth/device`, `POST /oauth/device`, and the device grant at `/oauth/token`. A client takes the grant in its `grant_types`. A pairwise client is refused, because the grant has no redirect to tie a sector to the client. |
| `oauth.device.codeTtlMinutes` | number | 10 | An integer from 1 to 30. The life of a device code and its user code. A user code has 8 letters of a set of 20, about 34.5 bits. Each count of the device page is a fixed 15-minute window that opens at its first call, so one code life can meet two or three windows. A 10-minute code meets two, and takes at most 9 guesses per session and 39 per IP. A 30-minute code meets three, and takes at most 14 and 59. A limiter of your own with windows on the clock allows 10 and 40 for a 10-minute code, and 15 and 60 for a 30-minute code. A limiter that counts per isolate multiplies each bound by the count of isolates. |
| `oauth.device.interval` | number | 5 | An integer from 5 to 60. The seconds between two polls. A poll that comes sooner answers `slow_down`, and the interval of that code grows by 5 seconds (RFC 8628 section 3.5). |
| `oauth.devicePage` | function of `DevicePageInput` | `defaultDevicePage` | Answers the markup of the device page: the code form, the consent with the warning line, and the end. |
| `oauth.registration.dynamic` | boolean | false | Serves `POST /oauth/register` of RFC 7591. Off by default since plan 12e: MCP 2026-07-28 calls dynamic registration deprecated. |
| `oauth.registration.initialAccessTokenHash` | string | none | The SHA-256 of an initial access token, as 64 lowercase hex characters. While it is set, `POST /oauth/register` needs `Authorization: Bearer <token>`, and a miss answers 401 `invalid_token`. Core stores the hash and never the token. With `dynamic` off, the config throws: no route reads the token. |
| `oauth.registration.cimd` | boolean | true | Accepts a client id that is the https URL of its metadata document. |

## Operator

Another key of `operator` is refused. Set `operator.secretHash` or `operator.secrets`, not both. With `operator.users` and `organizations.platformRole`, you can set neither. Only platform operators then use the tools, and each secret route answers 404 as a tool that is off. Each tool is off by default, so an upgrade opens no new route and widens no secret. A presented secret is compared against every entry, also after a match.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `operator.secretHash` | string | none | The SHA-256 of the operator secret as 64 lowercase hex characters. Core stores no secret. The secret must be 32 to 512 visible ASCII characters, and any other secret answers 401 with no reason. Since plan 12f it is one secret named `default` with the scopes `keys` and `secrets` only. |
| `operator.secrets` | list | none | One entry or more, each a named secret with its scopes. Two entries with one name or one hash are refused. |
| `operator.secrets[].name` | string | required | `^[a-z0-9][a-z0-9_-]{0,31}$`. The audit row names the secret by it. |
| `operator.secrets[].secretHash` | string | required | The SHA-256 of the secret as 64 lowercase hex characters, as `operator.secretHash`. |
| `operator.secrets[].scopes` | string list | required | One scope or more of `keys`, `secrets`, `users`, `sessions`, `audit`, and `sso`. `keys` opens `POST /operator/keys/rotate`, and `secrets` opens the secret status and rewrap routes. `sso` opens `POST /operator/sso/enforce-off` (plan 12d). A secret with no scope for a route gets 403 `operator_required`. |
| `operator.users` | `true` | off | Turns on the user, session, and audit tools of plan 12f. It needs a secret with the scope `users` or `organizations.platformRole`, so that an actor can use the tools. |
| `operator.impersonation` | object | off | Turns on impersonation. It needs `operator.users` and `organizations.platformRole`: only a platform operator starts one. |
| `operator.impersonation.ttlMinutes` | number | 60 | A whole number from 5 to 240. The life of an impersonation session. The sliding refresh never moves it. |
| `operator.impersonation.notice` | boolean | true | Sends the user a notice mail at each start. `account.notices: false` turns it off too. |

## SSO

`sso` turns on enterprise SSO (plan 12d). It needs `organizations`, else the config is refused with "sso needs organizations". Another key of `sso` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `sso` | object | off | Turns on the domain routes. See [Enterprise SSO](/docs/reference/routes/#enterprise-sso). |
| `sso.dns` | list | required | One DNS resolver or more, each an object with a `name` string and a `txt` function. Core has no default resolver: pick the presets `dohCloudflare` and `dohGoogle` with your fetch, or pass your own. Every resolver must give the value of a proof. Two resolvers: one resolver that is wrong or compromised must not give a domain to an organization. |
| `sso.oidc` | `true` | off | Turns on the OIDC connections (plan 12d Task 3). Each connection names how its token request sends the client secret, `tokenEndpointAuthMethod`: see [create a connection](/docs/reference/routes/#post-sso-connections-create). |
| `sso.saml` | `true` or object | off | Turns on the SAML connections (plan 12d Task 8). |
| `sso.saml.clockSkewSeconds` | number | 120 | A whole number from 0 to 300. |
| `sso.fetch` | function | `fetch` | The fetch of the calls to the sign-in provider of a connection. Core follows no redirect. Core reads the discovery document, the token answer, and the JWKS with a cap of 65536 bytes each. A larger answer fails the sign-in with `sso_failed`. |
| `sso.limits` | object | see below | The limits of one organization. |
| `sso.limits.connectionsPerOrganization` | number | 10 | A positive whole number. |
| `sso.limits.domainsPerOrganization` | number | 20 | A positive whole number. The add of one more domain answers `domain_limit`. |

## SCIM

`scim` turns on the SCIM token routes and the SCIM server under `<basePath>/scim/v2` (plan 12d). It needs `organizations`, else the config is refused with "scim needs organizations". Another key of `scim` is refused.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `scim` | object | off | Turns on the SCIM routes. See [SCIM](/docs/reference/routes/#scim). |
| `scim.groups` | string | `roles` | `roles`, `teams`, or `both`: what a SCIM group gives. `teams` and `both` need `organizations.teams`. |
| `scim.defaultRole` | string | `member` | The role of a member that SCIM adds. Each part is a role of the role table, below the owner rank, and never the platform role. A dynamic role is refused here: core checks the config at construction, and a dynamic role lives in one organization. The `defaultRole` of a connection may name a dynamic role of its organization. |

## Hooks

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `hooks.organization` | `OrganizationHooks` | none | Needs `organizations`. A name that is no hook point is refused. |
| `hooks.session` | `SessionHooks` | none | `beforeCreate`, `afterCreate`, and `afterEnd`. |
| `hooks.user` | `UserHooks` | none | `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeVerify`, and `afterVerify`. [Run your code at a hook point](/docs/guides/hooks/) gives the order. |
| `hooks.identity` | `IdentityHooks` | none | `beforeLink`, `afterLink`, `beforeUnlink`, and `afterUnlink`. The `email` identity fires none. |
| `hooks.operator` | `OperatorHooks` | none | Needs `operator.users`, `sso`, or `scim`. `beforeAction` runs before an operator act and can refuse it. `afterAction` gets each audit row after the commit, also the rows of SSO and SCIM; send the row to a separate system there. |
| `hooks.sso` | `SsoHooks` | none | Needs `sso`. `beforeSignIn` runs in an SSO sign-in before its first write and can refuse it. |
| `hooks.scim` | `ScimHooks` | none | Needs `scim`. `afterChange` runs once after the commit of each SCIM write. A throw writes one log line, and the write stays. |

## Captcha

The token comes in the header `x-captcha-response`. Core checks it after the per-IP limit of the flow. The check runs before every per-email limit, the password policy, the breach check, and the first read of a user. So a request with no token spends no per-email limit of an address, and costs no breach call. An in-process `api` call with no `captchaToken` skips the check. An app that proxies a browser request through `api` must pass the browser's token as `captchaToken`; without it, the check does not run.
Core serves its own sign-in page with `handoff` or `oauth`, unless `handoff.signInPage` replaces it. Then `captcha.port.page` is required when a gated flow is on that page. The page has the magic link form, and the password forms only with `password`. It has no email code form. Without the widget, the page sends no token, and every gated flow on it answers `captcha_required`.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `captcha` | object | off | Turns the check on for the flows in `captcha.flows`. |
| `captcha.port` | `CaptchaPort` | required | An object with `verify`. `@authtempo/captcha-turnstile` gives one. Its optional `page` puts the widget on core's sign-in page: `scriptSrc` is an https URL, `responseField` is 1 to 64 letters, digits, `_`, or `-`, and `cspSources` holds https origins with no path. |
| `captcha.flows` | `CaptchaFlow[]` | `password-sign-up`, `magic-link-request`, `email-otp-request`, `password-reset-request` | 1 or more distinct flows. `password-sign-in` and `phone-request` are off by default. `password-reset-request` covers the reset link and the reset code. `phone-request` covers the phone code request. |
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

## Username

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `username` | `UsernameConfig` or `false` | `false` | Turns on the username: `GET /username/available`, `POST /user/username`, and `username` at the password sign-up while `password.uniformSignUp` is false. With the uniform answer, the name of a sign-up would tell a known address from a new one. `{}` turns it on with the defaults. |
| `username.minLength` | number | 3 | An integer from 3 to 30. The fewest characters of the name after NFKC. |
| `username.maxLength` | number | 30 | An integer from `minLength` to 30. |
| `username.reserved` | string array | none | More names in the stored form that no account may take. Core always reserves `DEFAULT_RESERVED_SLUGS`, the organization slugs while organizations are on, `root`, `support`, `security`, and `admin`. |

## Last method

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `lastMethod` | `LastMethodConfig` or `false` | `false` | Each browser sign-in sets a cookie that a script can read, with the method: `password`, `username`, `phone`, `magic_link`, `email_otp`, `passkey`, or `social:<provider>`. Each JSON sign-in answer carries the same value as `via`. A request with an `Authorization` header gets no cookie. The cookie is a hint for the sign-in page only. Core never stores the method. `{}` turns it on. |
| `lastMethod.cookieName` | string | `"__Host-tempo_last_method"` | 1 to 64 token characters. Not the name of another cookie of core. |
| `lastMethod.days` | number | 30 | An integer from 1 to 400. |

## Observability

With no `observe`, core writes its log lines with `console` and sends nothing anywhere. With a sink, core buffers each event, and a flush sends the batch after the answer. Pass `{ waitUntil }` to `handle`, or call `auth.observe.flush()`.

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `observe` | object | off | Turns the event port on. An unknown key is refused. |
| `observe.sink` | `ObserveSink` | required | An object with `write(batch)`. Core waits for it for at most `observe.flushTimeoutMs`, and logs no error text of it. |
| `observe.include` | object | each key `"none"` | What an event may hold of an address. An unknown key is refused. |
| `observe.include.ip` | `"none"` \| `"hash"` \| `"raw"` | `"none"` | `"hash"` writes a keyed hash of 32 hex under the current app secret. A rotation changes every hash. `"raw"` drops a value that is not an IP address. |
| `observe.include.userAgent` | `"none"` \| `"raw"` | `"none"` | `"raw"` writes at most 256 characters with no control character. |
| `observe.include.email` | `"none"` \| `"hash"` | `"none"` | `"raw"` is refused: an event never holds a raw email. |
| `observe.trustTraceparent` | boolean | `false` | Takes the trace id of a valid W3C `traceparent` header. The client trace id then reaches a sink as it is, with no scrub. |
| `observe.buffer` | number | 1000 | An integer from 10 to 10000. A push into a full buffer drops the event and counts it. |
| `observe.flushTimeoutMs` | number | 2000 | An integer from 100 to 10000. A sink that answers later loses the batch, and core counts it. |
| `observe.readiness` | boolean | `false` | Turns on `GET <basePath>/ready`. |

## Next

- [Routes](/docs/reference/routes/)
- [The API reference](/docs/reference/api/)
- [Secrets](/docs/operations/secrets/)
