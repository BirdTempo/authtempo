---
title: The client package
description: Every option, operation, result, and export of @authtempo/client.
type: reference
sources:
  - packages/client/README.md "Create a client"
  - packages/client/README.md "Operations"
  - packages/client/README.md "Results"
  - packages/client/README.md "Account settings"
  - packages/client/src/client.ts
  - packages/client/src/index.ts
---

**For:** a developer who calls authtempo from a browser app, a native app, a desktop app, or a CLI.

**What it does:** this page lists the options of `createClient`, each operation with its route, the result type, and every export of the package. The export check holds this page to `packages/client/src/index.ts`.

## Before you start

- Read [Run the app on another origin](/docs/guides/split-origins/) when the app and the API have two origins.

## Options

`createClient(options)` answers a `Client`. The type of the options is `ClientOptions`.

| Option | Default | What it does |
| --- | --- | --- |
| `baseURL` | required | The origin of the API. One trailing `/` is removed. |
| `basePath` | `"/auth"` | The mount path of the routes. |
| `credentials` | `"include"` | A native app, a desktop app, and a CLI pass `"omit"`. Core reads the cookie before the bearer header. |
| `token` | none | A function that answers the bearer token, or null. |
| `fetch` | `globalThis.fetch` | The fetch of every call. |
| `webauthn` | `browserWebAuthn()` | The passkey seam, of the type `BrowserWebAuthn`. |
| `navigate` | `location.assign` | Sends the browser to the social start URL. A router or a test injects one. With the default and no `location`, as in a server render, `social.signIn` answers `unexpected`. |
| `broadcast` | `true` where `BroadcastChannel` exists | Tell the other tabs of the origin after a change, on the channel `authtempo-session`, and read again when one tells. |
| `refetchOnVisible` | `true` where `document` exists | Read the session again when the page becomes visible. |
| `onSessionEnd` | none | Runs with `sent`, the token that the read sent, when `session()` answers `null` to a 401. It does not run when no token was sent. Clear the stored token only when it is still `sent`: a newer sign-in may have written another. |

`createTransport(options)` answers a `Call` for a route of your own app's code. Its path is a `RoutePath` of `@authtempo/core/routes`, so a path that core does not serve fails the compile. A query goes in the fourth argument, never in the path. More request headers go in the fifth argument.

## Results

Every operation answers a `ClientResult`. A success is `{ ok: true, value }`. A failure is a `ClientFailure`: `{ ok: false, code, status }`.

- An operation never throws for an answer. Check `ok`, then read `code`.
- `status` is the HTTP status, or 0 when no answer arrived.
- `code` is a `ClientCode`: an `ErrorCode` of core, or one of the three codes below.

| Code | When it appears |
| --- | --- |
| `network` | The fetch rejected. The device is offline, the host is not reachable, or the browser blocked the answer. |
| `unexpected` | The answer is not JSON, or its error code is not in the core table. A session read, a handoff redeem, or an [account settings](#account-settings) operation that answers 200 with a body of another shape gives `unexpected` with status 200. |
| `cancelled` | The person dismissed the passkey prompt, or no authenticator matched. |

`client.errors` and the export `ERRORS` are the error table of core.

## The session store

`client.store` holds the session for a page. Its state, a `ClientSessionState`, is `{ data, error, isPending, isRefetching }`: `data` is the `PublicSession` or `null`, and `error` is a `ClientFailure` or `null`.

- `store.subscribe(listener)` adds a listener. The first one starts the first read. It answers the function that removes the listener.
- `store.get()` answers the state. The object stays the same until the next change.
- `store.refetch()` reads the session again.
- The store reads again after each sign-in and after the sign-out.
- It reads again after the second factor verify and enable, a password reset or change, and the address verify.
- It reads again after the active organization changes, after an organization delete or a member remove, and after the handoff redeem.
- It reads again after the revoke of a session, a profile update, an address change confirm, and the account delete.
- It reads again when another tab of the origin changes the session, and when the page becomes visible. It does not poll.

`createSessionStore` makes the same store over a read of your own.

## Operations

| Operation | Route | Value |
| --- | --- | --- |
| `client.session()` | `GET /session` | `PublicSession` or `null`. A 401 gives `null`, not a failure. With core's `session.deferRefresh` on, the session holds `needsRefresh`. `session.actorId` is the operator's user id in an impersonation session, else null |
| `client.session.refresh()` | `POST /session/refresh` | As `session()`. It slides the expiry and renews the cookie when the refresh is due. The store reads again. The store's own read calls it when `needsRefresh` is true, and keeps the GET answer if it fails. Call it yourself after a direct `session()`. |
| `client.signOut()` | `POST /sign-out` | `{ ok: true }` |
| `client.readRedirectError(url)` | none | The code of `?auth_error=<code>`: an `ErrorCode` or an `OAuthErrorCode`, because core's OAuth sign-in route sends a code of `OAUTH_ERRORS`. `unexpected` for a code that neither table has, or `null` |
| `client.social.startURL({ provider, next? })` | `GET /social/:provider/start` (built, not fetched) | `string`; `invalid_body` with status 0 for a name that core refuses |
| `client.social.signIn({ provider, next? })` | `GET /social/:provider/start` (a navigation) | `{ url }`; `unexpected` with status 0 when the default `navigate` finds no `location` |
| `client.signIn.password({ email, password, trustDevice?, next?, captchaToken? })` | `POST /password/sign-in`, then `POST /totp/verify` through `verify` | `PasswordSignIn`: `{ kind: "session", session }`, or `{ kind: "second-factor", challenge, expiresAt, methods, verify }`. `verify` takes `{ code }`, `{ backupCode }`, or `{ emailCode }`. For the passkey method, call `secondFactor.passkey.verify` |
| `client.magicLink.request({ email, next? })` | `POST /magic-link/request` | `{ sent: true }` |
| `client.magicLink.verify({ token, trustDevice? })` | `POST /magic-link/verify` | `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.passkey.register({ name? })` | `POST /passkey/register/options`, then `/passkey/register/verify` | `PasskeySummaryJSON` |
| `client.passkey.signIn({ autofill? })` | `POST /passkey/authenticate/options`, then `/passkey/authenticate/verify` | `PublicSession`. With `autofill: true` the browser waits for the autofill of a field with `autocomplete="username webauthn"`; with no conditional mediation it answers `cancelled` and sends nothing |
| `client.passkey.abort()` | none | Ends a waiting passkey ceremony, which answers `cancelled`. A new passkey ceremony also ends the waiting one, because a browser refuses a second pending request |
| `client.passkeys.list()` | `GET /passkeys` | `PasskeySummaryJSON[]` |
| `client.passkeys.delete({ id })` | `POST /passkeys/delete` | `{ ok: true }` |
| `client.passkeys.rename({ id, name })` | `POST /passkeys/rename` | `PasskeySummaryJSON`. No fresh session is needed |
| `client.handoff.redeem({ code, verifier })` | `POST /handoff/redeem` | `{ token }` and `PublicSession` |
| `client.password.signUp({ email, password, name? })` | `POST /password/sign-up` | `{ token }` and `PublicSession` |
| `client.password.signIn({ email, password, trustDevice?, next? })` | `POST /password/sign-in` | `{ token }` and `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.password.resendVerification({ email })` | `POST /password/verify/resend` | `{ sent: true }` |
| `client.password.verifyEmail({ token })` | `POST /password/verify` | `{ verified: true }` |
| `client.password.requestReset({ email, next? })` | `POST /password/reset/request` | `{ sent: true }` |
| `client.password.reset({ token, password, trustDevice? })` | `POST /password/reset` | `{ token }` and `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.password.change({ currentPassword?, newPassword })` | `POST /password/change` | `{ ok: true }` |
| `client.emailOtp.request({ email })` | `POST /otp/request` | `{ sent: true }` |
| `client.emailOtp.verify({ email, code, trustDevice? })` | `POST /otp/verify` | `{ token }` and `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.emailOtp.requestReset({ email })` | `POST /otp/reset/request` | `{ sent: true }` |
| `client.emailOtp.reset({ email, code, password, trustDevice? })` | `POST /otp/reset` | `{ token }` and `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.totp.setup({ password })` | `POST /totp/setup` | `{ secret, uri, backupCodes }` |
| `client.totp.enable({ code })` | `POST /totp/enable` | `TotpStatusJSON` |
| `client.totp.verify({ challenge, code?, backupCode?, emailCode?, trustDevice? })` | `POST /totp/verify` | `TwoFactorSessionJSON` |
| `client.totp.disable({ code })` | `POST /totp/disable` | `{ ok: true }` |
| `client.totp.regenerateBackupCodes({ code })` | `POST /totp/backup-codes` | `{ backupCodes }` |
| `client.totp.status()` | `GET /totp` | `TotpStatusJSON` |
| `client.totp.revokeTrustedDevices()` | `POST /totp/devices/revoke` | `{ ok: true }` |
| `client.secondFactor.passkey.enable({ password })` | `POST /passkey/authenticate/options`, then `POST /second-factor/passkey/enable` | `SecondFactorEnableJSON` |
| `client.secondFactor.passkey.verify({ challenge, trustDevice? })` | `POST /second-factor/passkey/options`, then `POST /totp/verify` | `TwoFactorSessionJSON` |
| `client.secondFactor.email.enable({ password })` | `POST /second-factor/email/enable` | `SecondFactorEnableJSON` |
| `client.secondFactor.email.send({ challenge })` | `POST /second-factor/email/send` | `{ sent: true }` |
| `client.secondFactor.disable({ method, password })` | `POST /second-factor/disable` | `{ ok: true, methods }` |
| `client.organizations.create({ slug, name, metadata? })` | `POST /organizations/create` | `{ organization: OrganizationJSON, member: MemberJSON }` |
| `client.organizations.list()` | `GET /organizations` | `{ organization, role }[]` |
| `client.organizations.update({ organizationId, name?, slug?, metadata? })` | `POST /organizations/update` | `OrganizationJSON` |
| `client.organizations.delete({ organizationId })` | `POST /organizations/delete` | `{ ok: true }` |
| `client.organizations.members.list({ organizationId })` | `GET /organizations/members` | `MemberJSON[]` |
| `client.organizations.members.add({ organizationId, userId, role })` | `POST /organizations/members/add` | `MemberJSON` |
| `client.organizations.members.role({ organizationId, userId, role })` | `POST /organizations/members/role` | `MemberJSON` |
| `client.organizations.members.remove({ organizationId, userId, revokeTokens? })` | `POST /organizations/members/remove` | `{ ok: true }`. `revokeTokens: true` deletes the person's organization tokens too |
| `client.organizations.invitations.invite({ organizationId, email, role })` | `POST /organizations/invite` | `InvitationJSON` |
| `client.organizations.invitations.list({ organizationId })` | `GET /organizations/invitations` | `InvitationJSON[]` |
| `client.organizations.invitations.revoke({ organizationId, invitationId })` | `POST /organizations/invitations/revoke` | `{ ok: true }` |
| `client.organizations.invitations.accept({ token })` | `POST /organizations/invitations/accept` | `{ organization, member }` |
| `client.organizations.invitations.decline({ token })` | `POST /organizations/invitations/decline` | `{ ok: true }` |
| `client.organizations.setActive({ organizationId })` | `POST /organizations/active` | `PublicSession` |
| `client.organizations.tokens.create({ organizationId, name, permissions, expiresInDays?, metadata? })` | `POST /organizations/tokens` | `{ token, apiToken: OrganizationTokenSummaryJSON }` |
| `client.organizations.tokens.list({ organizationId })` | `GET /organizations/tokens` | `OrganizationTokenSummaryJSON[]` |
| `client.organizations.tokens.update({ organizationId, id, name?, permissions?, expiresAt? })` | `POST /organizations/tokens/update` | `OrganizationTokenSummaryJSON`, after a narrow-only change |
| `client.organizations.tokens.revoke({ organizationId, id })` | `POST /organizations/tokens/revoke` | `{ ok: true }` |
| `client.organizations.tokens.current()` | `GET /organizations/tokens/current` | `{ organization, apiToken }`, with a `to_` token |
| `client.tokens.create({ name, expiresInDays?, organizationId?, permissions?, metadata? })` | `POST /tokens` | `{ token, apiToken: ApiTokenSummaryJSON }` |
| `client.tokens.list()` | `GET /tokens` | `ApiTokenSummaryJSON[]` |
| `client.tokens.revoke({ id })` | `POST /tokens/revoke` | `{ ok: true }` |
| `client.tokens.update({ id, name?, permissions?, expiresAt? })` | `POST /tokens/update` | `ApiTokenSummaryJSON`, after a narrow-only change |
| `client.tokens.current()` | `GET /tokens/current` | `{ user, apiToken }` |
| `client.jwt.token()` | `GET /token` | `{ token }` |
| `client.oauth.grants()` | `GET /oauth/grants` | `OAuthGrantJSON[]` |
| `client.oauth.revoke({ clientId })` | `POST /oauth/grants/revoke` | `{ ok: true }` |

The password, email code, and second factor operations answer `not_found` when the server turns the feature off.

For passkey autofill, start the autofill when the page loads, before a passkey button can run. A new passkey ceremony ends a waiting one, also a register.

## Account settings

These operations serve the settings page of the signed-in person. Each one needs a session, except `user.confirmEmailChange`.

| Operation | Route | Value |
| --- | --- | --- |
| `client.sessions.list()` | `GET /sessions` | `SessionSummaryJSON[]`, newest first. `current` marks the caller's session. `impersonation` marks a session that a platform operator opened, and names no operator |
| `client.sessions.revoke({ id })` | `POST /sessions/revoke` | `{ ok: true, current }`. See the rule below the table |
| `client.sessions.revokeOthers()` | `POST /sessions/revoke-others` | `{ ended }`, the count of ended sessions |
| `client.reauth.password({ password, code? })` | `POST /reauth` | `FreshJSON`. `code` is the second factor, while it is on |
| `client.reauth.requestEmailCode()` | `POST /reauth/email` | `{ sent: true }`. The code goes to the account's address |
| `client.reauth.emailCode({ emailCode, code? })` | `POST /reauth` | `FreshJSON` |
| `client.reauth.passkey()` | `POST /reauth/passkey/options`, then `POST /reauth` | `FreshJSON`. A dismissed prompt answers `cancelled` |
| `client.user.update({ name?, image? })` | `POST /user/update` | `{ user: PublicUserJSON }`. `null` clears a field |
| `client.user.changeEmail({ newEmail, method?, next? })` | `POST /user/change-email` | `{ sent: true }`. `method` is `link` (default) or `code` |
| `client.user.confirmEmailChange({ token })` | `POST /user/change-email/confirm` | `{ user: PublicUserJSON }`, for an app that serves its own confirm page |
| `client.user.verifyEmailChange({ code })` | `POST /user/change-email/verify` | `{ user: PublicUserJSON }` |
| `client.user.delete()` | `POST /user/delete` | `{ ok: true }`: the account and the caller's session end. `{ sent: true }`: the server's `account.deleteConfirm` is on, a link went to the address, and nothing is deleted yet |
| `client.user.confirmDelete({ token })` | `POST /user/delete/confirm` | `{ ok: true }`, for an app that serves its own confirm page of the mailed delete link. It needs a session of the same user, not a fresh one |
| `client.identities.list()` | `GET /identities` | `IdentityListJSON`: `identities`, `password`, `passkeys` |
| `client.identities.unlink({ id })` | `POST /identities/unlink` | `{ ok: true }` |
| `client.identities.link({ provider, next? })` | `POST /social/:provider/link`, then a navigation | `{ url }`; `invalid_body` with status 0 for a name that core refuses |

`GET /user/change-email/confirm` is the page of the mailed link. A browser opens it, so the client has no call for it.

**The revoke of the caller's own session.** The answer's `current` is true when `id` is the id of the caller's own session. Then that session has ended. A browser loses the cookie, and a bearer app must clear its stored token.

**A fresh session.** Some changes need a fresh session: a sign-in or a re-authentication that is younger than `session.freshMinutes`. A stale session gets `session_not_fresh` (403), and nothing changes. These calls can answer it:

- `sessions.revoke`, `sessions.revokeOthers`
- `user.changeEmail`, `user.delete`
- `identities.unlink`, `identities.link`
- `passkey.register`, `passkeys.delete`
- `tokens.create`, `tokens.update`
- `totp.enable`, `totp.disable`, `totp.regenerateBackupCodes`
- `secondFactor.passkey.enable`, `secondFactor.email.enable`, `secondFactor.disable`
- `password.change` while the second factor is on, and for a first password

`withFresh(op, reauth)` gives the path. It runs `op`, the change. On `session_not_fresh`, it runs `reauth`, the re-authentication of your page, then `op` once more. An example is `client.withFresh(() => client.user.delete(), () => client.reauth.password({ password }))`.

A failed re-authentication is the answer, and the change does not run again. A second `session_not_fresh` is the answer too, so `withFresh` never loops. A re-authentication keeps the session token. Core checks the rule of `secondFactor.passkey.enable` after its passkey prompt. So under `withFresh`, that call can show the prompt two times.

**The link of a provider.** `identities.link` posts the start. Then it sends the browser to the provider through `navigate`. The client navigates only to an `http:` or an `https:` URL. The provider sends the browser back to `next`. A failure lands on `?auth_error=<code>`, for example `identity_taken`, `email_mismatch`, or `email_required`. Read the code with `readRedirectError`.

**Error codes.** [Routes](/docs/reference/routes/) gives every error of each route. The codes of these operations include `session_not_fresh`, `last_credential`, `identity_taken`, `sole_owner`, `email_taken`, and `conflict`. [Error codes](/docs/reference/errors/) explains each one, and `errorText` has a sentence for each.

## Error texts and links

`errorText(code)` answers one sentence for a code, for an app to show to a person. `errorDocsURL(code)` answers the docs page of the code: its anchor on [Error codes](/docs/reference/errors/), or the [Results](#results) section for `network`, `unexpected`, and `cancelled`. `redirect_mismatch` links to the [failure codes of the handoff](/docs/reference/handoff/#failure-codes). Pass `"oauth"` as the second argument for a code of the OAuth client, because `invalid_token` and `rate_limited` are in both tables. `ERROR_TEXT` holds every text, by table.

`errorText(code, locale)` answers the text in a language of `LOCALES`. English (`"en"`) is the default and the only language of the list. For a code of the OAuth client, the locale is the third argument: `errorText(code, "oauth", locale)`. `resolveLocale(navigator.language)` picks the locale of a language tag, else English. The docs link of a code is the same in every language.

## Exports

| Export | What it is |
| --- | --- |
| `createClient` | Makes a `Client`. |
| `createTransport` | The typed call for a route of your own app's code, with its `TransportOptions` and the `Call` type. The client uses the same request code, and takes its paths from `CLIENT_CALLS`. |
| `browserWebAuthn` | The passkey seam of a browser, on `navigator.credentials`. |
| `supportsPasskeys` | True when the browser can run the passkey ceremonies. |
| `supportsAutofill` | True when the browser has conditional mediation for passkeys. |
| `readRedirectError` | The redirect error reader of `client.readRedirectError`. |
| `credentialToJSON` | Converts a credential of the browser to the JSON that core reads. |
| `toBinaryCreationOptions`, `toBinaryRequestOptions` | Convert the options JSON of core for a browser with no `parseCreationOptionsFromJSON`. |
| `base64UrlEncode`, `base64UrlDecode` | The base64url codec of the conversions. |
| `WebAuthnCancelled` | The error that the seam throws for a dismissed prompt. The client answers `cancelled` for it. |
| `ERRORS` | The error table of core. |
| `CLIENT_CALLS` | The table of every route that the client calls, with each operation, method, and path. The client takes each path from it. |
| `createSessionStore` | Makes a session store over a read function. |
| `SESSION_CHANNEL` | The name of the `BroadcastChannel`, `authtempo-session`. |
| `errorText` | One sentence for a code. |
| `errorDocsURL` | The docs link of a code. |
| `ERROR_TEXTS` | Every error text, by language and table. |
| `LOCALES` | The languages of the error texts: `["en"]`. |
| `resolveLocale` | The locale of a language tag, else English. |
| `errorAnchor` | The anchor of a code on the errors page. |
| `ERROR_TEXT` | Every error text, by table. |
| `DOCS_ORIGIN` | The origin of the docs, `https://authtempo.com`. |

The types of the package:

| Area | Types |
| --- | --- |
| The client | `Client`, `ClientOptions`, `ClientResult`, `ClientFailure`, `ClientCode`, `OAuthClientCode`, `OAuthFailure`, `OAuthResult`, `SdkCode`, `ErrorTable`, `ErrorCode`, `Call`, `Query`, `TransportOptions`, `ClientCall`, `ClientOperation`, `ClientSessionState`, `SessionState`, `SessionStore`, `Locale`, `ErrorTexts` |
| Passkeys | `BrowserWebAuthn`, `CredentialsContainerLike`, `PublicKeyCredentialLike`, `PasskeySummaryJSON`, `CeremonyOptions` |
| Answers | `ApiTokenSummaryJSON`, `OrganizationTokenSummaryJSON`, `InvitationJSON`, `MemberJSON`, `RoleJSON`, `TeamJSON`, `TeamMemberJSON`, `OAuthGrantJSON`, `OrganizationJSON`, `TotpStatusJSON`, `ChallengeMethodJSON`, `SecondFactorEnableJSON`, `TwoFactorChallengeJSON`, `TwoFactorSessionJSON`, `PasswordSignIn` |
| Account settings | `SessionSummaryJSON`, `FreshJSON`, `PublicUserJSON`, `IdentityEntryJSON`, `IdentityListJSON` |

## Next

- [Routes](/docs/reference/routes/)
- [Error codes](/docs/reference/errors/)
- [The handoff package](/docs/reference/handoff/)
