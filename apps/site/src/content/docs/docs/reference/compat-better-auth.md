---
title: Better Auth compatibility
description: The package aliases, the plugins, and the options that @authtempo/compat-better-auth keeps or refuses at start.
type: reference
sources:
  - packages/compat-better-auth/README.md "The alias"
  - packages/compat-better-auth/README.md "What fails at start"
  - packages/compat-better-auth/README.md "Plugins"
  - packages/compat-better-auth/README.md "Account operations"
  - packages/compat-better-auth/README.md "JWT and the OAuth provider"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 16.1
---

**For:** a developer who moves an app of Better Auth 1.7 to authtempo and keeps the app's code.

**What it does:** this page lists what the compatibility package answers for each Better Auth import, each plugin, and each default. [Move from Better Auth](/docs/migrate/better-auth/) gives the steps.

## Before you start

- The app runs Better Auth 1.7. [From Better Auth](/docs/migrate/better-auth/) tells how to move it.

## The rule

`betterAuth(options)` checks every option against an allow list. One `BetterAuthCompatError` lists every option, plugin, and provider that authtempo cannot keep. The app then fails at start and never at run time. The error's `refusals` holds the list.

## The aliases

Point each Better Auth package name that the app imports at the compatibility package, with the `npm:` form in `package.json`.

| Import in the app | Answered by |
| --- | --- |
| `better-auth` | `.` |
| `better-auth/plugins` | `./plugins` |
| `better-auth/react` | `./react` |
| `better-auth/client` | `./client` |
| `better-auth/client/plugins` | `./client/plugins` |
| `better-auth/adapters/drizzle`, `@better-auth/drizzle-adapter` | `./adapters/drizzle` and `.` |
| `better-auth/node` | `./node` |
| `better-auth/api` | `./api`, which exports `APIError` only |
| `better-auth/next-js` | `./next-js` |
| `@better-auth/expo` | `.`, the `expo` plugin |
| `@better-auth/expo/client` | `./client`, the `expoClient` plugin |
| `@better-auth/passkey` | `.`, the `passkey` plugin |
| `@better-auth/passkey/client` | `./client`, the `passkeyClient` plugin |

An import of another subpath, such as `better-auth/db` or `better-auth/plugins/access`, fails at build. Remove those imports first.

## The plugins

| Plugin | What it does on authtempo |
| --- | --- |
| `organization` | Core's organizations. `sendInvitationEmail` is required. |
| `passkey` | Core's passkeys. `rpID`, `rpName`, and `origin` are required. |
| `magicLink` | Core's magic link with its confirm page. `sendMagicLink` is required. |
| `emailOTP` | Core's email codes, for the sign-in and the reset. With `changeEmail: { enabled: true }`, also for the change of address. `sendVerificationOTP` is required. |
| `bearer` | Adds `set-auth-token` to each answer that sets the session cookie. |
| `expo` | Core's handoff through the system browser. `trustedOrigins` must hold the app scheme. |
| `twoFactor` | Core's TOTP second factor on the password sign-in. Pass `accountLockout: { enabled: false }`. Core's gate on the magic link, the email code, and social stays off. A reset by code of a user with the factor on opens no session. |
| `jwt`, `mcp`, `cimd`, `oidc-provider`, `oauth-provider` | Refused at start. Move to core's `createAuth` with `jwtMint` and `oauth`. |

Any other plugin is refused at start by its id.

## The defaults

Better Auth's defaults apply. A session lives 7 days and refreshes after 1 day. A reset link lives 1 hour, a magic link 5 minutes, and an invitation 2 days.

| Better Auth default | On authtempo |
| --- | --- |
| The client IP comes from `x-forwarded-for` | It comes from `cf-connecting-ip`. Off Workers, set `advanced.ipAddress.ipAddressHeaders`. |
| An absolute `callbackURL` on any trusted origin | Only the origin of `authtempo.appURL` keeps its path. Any other answers 403. |
| A reset keeps the other sessions | A reset ends every session. |
| The verify link lives 1 hour | It lives as long as the magic link. |
| `requireEmailVerification: true` mails a new link at an unverified sign-in only with `sendOnSignIn: true` | It maps to `password.requireVerified`. The sign-in answers `EMAIL_NOT_VERIFIED` and always mails a new link, at most 3 per 15 minutes. `sendOnSignIn: false` is refused at start. |
| `trustedOrigins` takes a function and wildcards | Each entry is an exact origin or an app scheme. |
| The session cookie `better-auth.session_token` | The session cookie `__Host-tempo_session`. For one release the shim also reads `tempo_session`, the name before plan 12b, and the handler moves it. |
| `secrets: [{ version, value }]` accepts version 0 | It maps to core's `secrets`, one entry for one entry. Version 0 is refused: core reads a row from before plan 12b as version 1, so renumber from 1. With `secret`, version 1 must be the value of `secret`. |
| `BETTER_AUTH_SECRETS` in the environment | Not read: the shim maps options only. Pass the list as `secrets`. |
| A secret under 32 characters, or with low entropy, gets a warning | Refused at start. Each value needs 32 characters or more. The current value, `secrets[0]` or `secret`, also needs an estimated 100 bits of entropy. Make one with `openssl rand -base64 32`. |
| `autoSignIn: false` answers `{ token: null, user }` | Refused at start, unless `requireEmailVerification` is true: core opens a session at sign-up without it. With it, the pair acts as `requireEmailVerification` alone, as in Better Auth. |
| A sign-up answers a session unless `requireEmailVerification` is true, and `USER_ALREADY_EXISTS` for a taken address | The same. The shim sets core's `password.uniformSignUp: false`, so a caller can learn that an address has an account, as with Better Auth. |
| `disableSignUp` on each method and provider, and a provider's `disableImplicitSignUp` | Core has one sign-up rule. `true` on every method and social provider that creates a user maps to core's `signUp: false`. A mix is refused at start, with the methods of each group. `disableImplicitSignUp` is refused. `api.signUpEmail` then answers `EMAIL_PASSWORD_SIGN_UP_DISABLED` with 400. The client's `signUp.email` answers the same code with core's status, 403. |

- `toNodeHandler` and `toNextJsHandler` throw `BetterAuthCompatError` at creation for an instance with no `ipAddressHeaders` and no `disableIpTracking: true`.
- A call argument that core cannot keep, such as `rememberMe: false`, answers `APIError` `NOT_SUPPORTED` with status 501.
- `APIError` and the client's `error` carry Better Auth's code and core's HTTP status. `BETTER_AUTH_CODES` is the table.

## The account operations

The shim serves Better Auth 1.7.2's account operations in Better Auth's shapes. Each is a method of `auth.api` and a path of `auth.handler`. The handler posts core's own route for each path, so core's Origin rule, CORS, and cookie renewals apply.

| Better Auth call | Path | Answer |
| --- | --- | --- |
| `listSessions` | `GET /list-sessions` | The live sessions. `token` holds the row id of each session. |
| `revokeSession({ token })` | `POST /revoke-session` | `{ status: true }`, also for an unknown token |
| `revokeSessions` | `POST /revoke-sessions` | `{ status: true }`. Every session ends, the caller's too. |
| `revokeOtherSessions` | `POST /revoke-other-sessions` | `{ status: true }` |
| `updateUser({ name, image })` | `POST /update-user` | `{ status: true }` |
| `changeEmail({ newEmail, callbackURL })` | `POST /change-email` | `{ status: true }` |
| `deleteUser({ password })` | `POST /delete-user` | `{ success: true, message: "User deleted" }` |
| `listUserAccounts` | `GET /list-accounts` | The provider accounts and the credential account |
| `linkSocial`, through the handler only | `POST /link-social` | `{ url, redirect }` |
| `unlinkAccount({ accountId })` | `POST /unlink-account` | `{ status: true }` |

The options of these operations:

| Option | Rule |
| --- | --- |
| `session.freshAge` | 1 to 86400 seconds, rounded up to whole minutes. Default one day. `0` is refused: the fresh rule is a promise of core. |
| `session.deferSessionRefresh` | Maps to core's `session.deferRefresh`. A GET writes no session row, and `GET /get-session` answers `needsRefresh`. `POST /get-session` slides the expiry and renews the cookie. |
| `user.changeEmail` | `enabled` turns the change on. It needs `emailVerification.sendVerificationEmail`. `sendChangeEmailConfirmation` and `updateEmailWithoutVerification: true` are refused. |
| `user.deleteUser` | `enabled` turns the delete on, off by default as in Better Auth. `beforeDelete` and `afterDelete` map. `sendDeleteAccountVerification` and `deleteTokenExpiresIn` are refused. |
| `account.accountLinking` | `enabled: true`, `allowDifferentEmails: false`, and `allowUnlinkingAll: false` are accepted. `trustedProviders`, `updateUserInfoOnLink`, and `disableImplicitLinking` are refused. |
| `emailOTP({ changeEmail })` | `enabled` serves `/email-otp/request-email-change` and `/email-otp/change-email`. `verifyCurrentEmail: true` is refused. |
| `databaseHooks.user`, `databaseHooks.account` | `create`, `update`, and `delete` of a user, and `create` and `delete` of an account, map onto core's hooks. |

Where the shim differs from Better Auth:

| On Better Auth | On authtempo |
| --- | --- |
| `listSessions` answers the clear token of each session | It answers the row id of each session in `token`. The shim stores the hash of a token, never the token. `revokeSession` takes that id or a clear token. |
| A revoke of the caller's own session keeps the cookie | Through the handler, core clears it. |
| Only the list, the unlink, and the delete need a fresh session | A revoke, the change of address, the link, the unlink, and the delete need one. A stale session answers `SESSION_NOT_FRESH` with 403. The list needs none. |
| `/two-factor/disable`, `/two-factor/get-totp-uri`, and `/two-factor/generate-backup-codes` ask for the password only | They also need a fresh session, checked before the password. A stale session answers `SESSION_NOT_FRESH` with 403. |
| A core route answers `{ error: "session_not_fresh" }` | Through the handler, the answer also carries `code: "SESSION_NOT_FRESH"`. |
| `deleteUser({ password })` skips `freshAge` | It re-authenticates first. A wrong password answers `INVALID_EMAIL_OR_PASSWORD`, not `INVALID_PASSWORD`. |
| `deleteUser` can mail a link with `token` and `callbackURL` | Each answers `NOT_SUPPORTED` with 501. The fresh session is the proof. |
| The delete keeps an organization with no owner | An organization where the user is the last owner and other members remain stops the delete: `SOLE_OWNER`, 409. |
| `updateUser` drops a field it does not know | It takes `name` and `image`, for a verified address only. `email` answers `EMAIL_CAN_NOT_BE_UPDATED`. Any other field answers `FIELD_NOT_ALLOWED`. |
| The change link goes to `sendVerificationEmail` and changes the address at once | The link goes to the same callback, to the new address. It opens core's confirm page. A taken address gets no mail, as on Better Auth. |
| A link needs the verified flag or a trusted provider, and an equal address unless `allowDifferentEmails` | A link needs the provider's verified address, equal to the account's. Else the callback answers `email_mismatch`. A provider address must not take an account. |
| The unlink of the last account answers `FAILED_TO_UNLINK_LAST_ACCOUNT` with 400 | The same code with 409, by the last-credential guard. |
| For a user with one account, an unknown id answers `FAILED_TO_UNLINK_LAST_ACCOUNT` | An unknown id answers `ACCOUNT_NOT_FOUND`. |
| The credential account can be unlinked | Its unlink answers `NOT_SUPPORTED` with 501. Core has no password removal. |
| No mail after a credential change | The same. The shim sets core's `account.notices: false`. Use core's `createAuth` for the notice mails. |
| The user delete runs the account delete hooks | It runs none. A credential account fires no account hook, because core's password row is not an identity. |

The shim's own codes `EMAIL_CAN_NOT_BE_UPDATED`, `FIELD_NOT_ALLOWED`, `ACCOUNT_NOT_FOUND`, and `CHANGE_EMAIL_DISABLED` answer 400, as on Better Auth.

`GET /get-session` answers `{ session, user }`, or `null` with no session, as on Better Auth. With `session.deferSessionRefresh` off, `POST /get-session` answers `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` with 405, as on Better Auth.

## Next

- [Move from Better Auth](/docs/migrate/better-auth/)
- [Schema and migrations](/docs/reference/schema/)
- [The cutover](/docs/migrate/cutover/)
