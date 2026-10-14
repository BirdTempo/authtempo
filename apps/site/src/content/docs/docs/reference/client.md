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

## Operations

| Operation | Route | Value |
| --- | --- | --- |
| `client.session()` | `GET /session` | `PublicSession` or `null`. A 401 gives `null`, not a failure. |
| `client.signOut()` | `POST /sign-out` | `{ ok: true }` |
| `client.magicLink.request({ email, next? })` | `POST /magic-link/request` | `{ sent: true }` |
| `client.magicLink.verify({ token })` | `POST /magic-link/verify` | `PublicSession` |
| `client.passkey.register({ name? })` | `POST /passkey/register/options`, then `/passkey/register/verify` | `PasskeySummaryJSON` |
| `client.passkey.signIn()` | `POST /passkey/authenticate/options`, then `/passkey/authenticate/verify` | `PublicSession` |
| `client.passkeys.list()` | `GET /passkeys` | `PasskeySummaryJSON[]` |
| `client.passkeys.delete({ id })` | `POST /passkeys/delete` | `{ ok: true }` |
| `client.handoff.redeem({ code, verifier })` | `POST /handoff/redeem` | `{ token }` and `PublicSession` |
| `client.password.signUp({ email, password, name? })` | `POST /password/sign-up` | `{ token }` and `PublicSession` |
| `client.password.signIn({ email, password, trustDevice?, next? })` | `POST /password/sign-in` | `{ token }` and `PublicSession`, or a `TwoFactorChallengeJSON` |
| `client.password.resendVerification({ email })` | `POST /password/verify/resend` | `{ sent: true }` |
| `client.password.verifyEmail({ token })` | `POST /password/verify` | `{ verified: true }` |
| `client.password.requestReset({ email, next? })` | `POST /password/reset/request` | `{ sent: true }` |
| `client.password.reset({ token, password })` | `POST /password/reset` | `{ token }` and `PublicSession` |
| `client.password.change({ currentPassword?, newPassword })` | `POST /password/change` | `{ ok: true }` |
| `client.emailOtp.request({ email })` | `POST /otp/request` | `{ sent: true }` |
| `client.emailOtp.verify({ email, code })` | `POST /otp/verify` | `{ token }` and `PublicSession` |
| `client.emailOtp.requestReset({ email })` | `POST /otp/reset/request` | `{ sent: true }` |
| `client.emailOtp.reset({ email, code, password })` | `POST /otp/reset` | `{ token }` and `PublicSession` |
| `client.totp.setup({ password })` | `POST /totp/setup` | `{ secret, uri, backupCodes }` |
| `client.totp.enable({ code })` | `POST /totp/enable` | `TotpStatusJSON` |
| `client.totp.verify({ challenge, code?, backupCode?, trustDevice? })` | `POST /totp/verify` | `TwoFactorSessionJSON` |
| `client.totp.disable({ code })` | `POST /totp/disable` | `{ ok: true }` |
| `client.totp.regenerateBackupCodes({ code })` | `POST /totp/backup-codes` | `{ backupCodes }` |
| `client.totp.status()` | `GET /totp` | `TotpStatusJSON` |
| `client.totp.revokeTrustedDevices()` | `POST /totp/devices/revoke` | `{ ok: true }` |
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
| `createTransport` | The request layer under the client, with its `TransportOptions` and the `Call` type. |
| `browserWebAuthn` | The passkey seam of a browser, on `navigator.credentials`. |
| `supportsPasskeys` | True when the browser can run the passkey ceremonies. |
| `credentialToJSON` | Converts a credential of the browser to the JSON that core reads. |
| `toBinaryCreationOptions`, `toBinaryRequestOptions` | Convert the options JSON of core for a browser with no `parseCreationOptionsFromJSON`. |
| `base64UrlEncode`, `base64UrlDecode` | The base64url codec of the conversions. |
| `WebAuthnCancelled` | The error that the seam throws for a dismissed prompt. The client answers `cancelled` for it. |
| `ERRORS` | The error table of core. |

The types of the package:

| Area | Types |
| --- | --- |
| The client | `Client`, `ClientOptions`, `ClientResult`, `ClientFailure`, `ClientCode`, `ErrorCode`, `Call`, `TransportOptions` |
| Passkeys | `BrowserWebAuthn`, `CredentialsContainerLike`, `PublicKeyCredentialLike`, `PasskeySummaryJSON` |
| Answers | `ApiTokenSummaryJSON`, `InvitationJSON`, `MemberJSON`, `OAuthGrantJSON`, `OrganizationJSON`, `TotpStatusJSON`, `TwoFactorChallengeJSON`, `TwoFactorSessionJSON` |

## Next

- [Routes](/docs/reference/routes/)
- [Error codes](/docs/reference/errors/)
- [The handoff package](/docs/reference/handoff/)
