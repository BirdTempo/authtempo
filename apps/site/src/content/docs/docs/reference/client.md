---
title: The client package
description: Every option, operation, result, and export of @authtempo/client.
type: reference
sources:
  - packages/client/README.md "Create a client"
  - packages/client/README.md "Operations"
  - packages/client/README.md "Results"
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
| `navigate` | `location.assign` | Sends the browser to the social start URL. A router or a test injects one. |
| `broadcast` | `true` where `BroadcastChannel` exists | Tell the other tabs of the origin after a change, on the channel `authtempo-session`, and read again when one tells. |
| `refetchOnVisible` | `true` where `document` exists | Read the session again when the page becomes visible. |
| `onSessionEnd` | none | Runs when `session()` answers `null` to a read that sent a token. Clear the stored token there, so the next read sends none. |

`createTransport(options)` answers a `Call` for a route of your own app's code. Its path is a `RoutePath` of `@authtempo/core/routes`, so a path that core does not serve fails the compile. A query goes in the fourth argument, never in the path. More request headers go in the fifth argument.

## Results

Every operation answers a `ClientResult`. A success is `{ ok: true, value }`. A failure is a `ClientFailure`: `{ ok: false, code, status }`.

- An operation never throws for an answer. Check `ok`, then read `code`.
- `status` is the HTTP status, or 0 when no answer arrived.
- `code` is a `ClientCode`: an `ErrorCode` of core, or one of the three codes below.

| Code | When it appears |
| --- | --- |
| `network` | The fetch rejected. The device is offline, the host is not reachable, or the browser blocked the answer. |
| `unexpected` | The answer is not JSON, or its error code is not in the core table. |
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
- It reads again when another tab of the origin changes the session, and when the page becomes visible. It does not poll.

`createSessionStore` makes the same store over a read of your own.

## Operations

| Operation | Route | Value |
| --- | --- | --- |
| `client.session()` | `GET /session` | `PublicSession` or `null`. A 401 gives `null`, not a failure. |
| `client.signOut()` | `POST /sign-out` | `{ ok: true }` |
| `client.readRedirectError(url)` | none | The `ErrorCode` of `?auth_error=<code>`, `unexpected` for a code that core's table lacks, or `null` |
| `client.social.startURL({ provider, next? })` | `GET /social/:provider/start` (built, not fetched) | `string`; `invalid_body` with status 0 for a name that core refuses |
| `client.social.signIn({ provider, next? })` | `GET /social/:provider/start` (a navigation) | `{ url }` |
| `client.signIn.password({ email, password, trustDevice?, next? })` | `POST /password/sign-in`, then `POST /totp/verify` through `verify` | `PasswordSignIn`: `{ kind: "session", session }`, or `{ kind: "second-factor", challenge, expiresAt, verify }` |
| `client.magicLink.request({ email, next? })` | `POST /magic-link/request` | `{ sent: true }` |
| `client.magicLink.verify({ token, trustDevice? })` | `POST /magic-link/verify` | `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.passkey.register({ name? })` | `POST /passkey/register/options`, then `/passkey/register/verify` | `PasskeySummaryJSON` |
| `client.passkey.signIn({ autofill? })` | `POST /passkey/authenticate/options`, then `/passkey/authenticate/verify` | `PublicSession`. With `autofill: true` the browser waits for the autofill of a field with `autocomplete="username webauthn"`; with no conditional mediation it answers `cancelled` and sends nothing |
| `client.passkey.abort()` | none | Ends a waiting autofill sign-in, which answers `cancelled` |
| `client.passkeys.list()` | `GET /passkeys` | `PasskeySummaryJSON[]` |
| `client.passkeys.delete({ id })` | `POST /passkeys/delete` | `{ ok: true }` |
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
| `client.organizations.members.remove({ organizationId, userId })` | `POST /organizations/members/remove` | `{ ok: true }` |
| `client.organizations.invitations.invite({ organizationId, email, role })` | `POST /organizations/invite` | `InvitationJSON` |
| `client.organizations.invitations.list({ organizationId })` | `GET /organizations/invitations` | `InvitationJSON[]` |
| `client.organizations.invitations.revoke({ organizationId, invitationId })` | `POST /organizations/invitations/revoke` | `{ ok: true }` |
| `client.organizations.invitations.accept({ token })` | `POST /organizations/invitations/accept` | `{ organization, member }` |
| `client.organizations.invitations.decline({ token })` | `POST /organizations/invitations/decline` | `{ ok: true }` |
| `client.organizations.setActive({ organizationId })` | `POST /organizations/active` | `PublicSession` |
| `client.tokens.create({ name, expiresInDays?, organizationId? })` | `POST /tokens` | `{ token, apiToken: ApiTokenSummaryJSON }` |
| `client.tokens.list()` | `GET /tokens` | `ApiTokenSummaryJSON[]` |
| `client.tokens.revoke({ id })` | `POST /tokens/revoke` | `{ ok: true }` |
| `client.tokens.current()` | `GET /tokens/current` | `{ user, apiToken }` |
| `client.jwt.token()` | `GET /token` | `{ token }` |
| `client.oauth.grants()` | `GET /oauth/grants` | `OAuthGrantJSON[]` |
| `client.oauth.revoke({ clientId })` | `POST /oauth/grants/revoke` | `{ ok: true }` |

The password, email code, and second factor operations answer `not_found` when the server turns the feature off.

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

The types of the package:

| Area | Types |
| --- | --- |
| The client | `Client`, `ClientOptions`, `ClientResult`, `ClientFailure`, `ClientCode`, `ErrorCode`, `Call`, `Query`, `TransportOptions`, `ClientCall`, `ClientOperation`, `ClientSessionState`, `SessionState`, `SessionStore` |
| Passkeys | `BrowserWebAuthn`, `CredentialsContainerLike`, `PublicKeyCredentialLike`, `PasskeySummaryJSON`, `CeremonyOptions` |
| Answers | `ApiTokenSummaryJSON`, `InvitationJSON`, `MemberJSON`, `OAuthGrantJSON`, `OrganizationJSON`, `TotpStatusJSON`, `ChallengeMethodJSON`, `SecondFactorEnableJSON`, `TwoFactorChallengeJSON`, `TwoFactorSessionJSON`, `PasswordSignIn` |

## Next

- [Routes](/docs/reference/routes/)
- [Error codes](/docs/reference/errors/)
- [The handoff package](/docs/reference/handoff/)
