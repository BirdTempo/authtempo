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
  - packages/compat-better-auth/README.md "The admin plugin"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 26
  - packages/compat-better-auth/README.md "API keys"
  - packages/compat-better-auth/README.md "Sign-in plugins"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 16.1
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 7"
  - docs/superpowers/plans/2026-10-14-12j-release-program.md "Task 3"
---

**For:** a developer who moves an app of Better Auth 1.7 to authtempo and keeps the app's code.

**What it does:** this page lists what the compatibility package answers for each Better Auth import, each plugin, and each default. [Move from Better Auth](/docs/migrate/better-auth/) gives the steps.

## Before you start

- The app runs Better Auth 1.7. [From Better Auth](/docs/migrate/better-auth/) tells how to move it.

Supported Better Auth versions: `>=1.7.7 <1.8.0`.

Warning: the rollback system must run Better Auth 1.7.7 or later. Better Auth below 1.7.7 has the advisory GHSA-965c-763c-88jm. Those versions accept the state of an OAuth sign-in as a magic link, so an attacker can sign in as another user. The old system stays the rollback target during the move.

The shim was read on the shapes of Better Auth 1.7.2 and on the `@better-auth/api-key` plugin of 1.7.5. The package exports the range as `BETTER_AUTH_RANGE`. A new Better Auth minor gets a compat change in an authtempo minor, never in a patch.

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
| `@better-auth/api-key` | `./api-key`, the `apiKey` plugin |
| `@better-auth/api-key/client` | `./api-key/client`, the `apiKeyClient` plugin |

An import of another subpath, such as `better-auth/db` or `better-auth/plugins/access`, fails at build. Remove those imports first.

## The plugins

| Plugin | What it does on authtempo |
| --- | --- |
| `organization` | Core's organizations. `sendInvitationEmail` is required. |
| `passkey` | Core's passkeys. `rpID`, `rpName`, and `origin` are required. `registration.requireSession: false`, `resolveUser`, and `afterVerification` are refused: core's `passkey.signUp` is the sign-up by passkey, and the shim does not map it. |
| `magicLink` | Core's magic link with its confirm page. `sendMagicLink` is required. |
| `emailOTP` | Core's email codes, for the sign-in and the reset. With `changeEmail: { enabled: true }`, also for the change of address. `sendVerificationOTP` is required. |
| `bearer` | Adds `set-auth-token` to each answer that sets the session cookie. |
| `expo` | Core's handoff through the system browser. `trustedOrigins` must hold the app scheme. |
| `twoFactor` | Core's TOTP second factor on the password sign-in. Pass `accountLockout: { enabled: false }`. Core's gate on the magic link, the email code, and social stays off. A reset by code of a user with the factor on opens no session. |
| `admin` | Core's operator tools. Needs `organization` and `authtempo.platformOrganization`. See [The admin plugin](#the-admin-plugin). |
| `apiKey` | Core's API tokens: `tk_` for `references: "user"`, `to_` for `"organization"`. `rateLimit` is the window of a new key. `enableSessionForAPIKeys: true`, `disableKeyHashing: true`, and a custom generator are refused. [Cutover of API tokens](/docs/migrate/better-auth/#cutover-of-api-tokens) moves the old keys. |
| `anonymous` | Core's anonymous sign-in. `onLinkAccount` runs after the sign-in that replaces the anonymous user, with core's `proof`. `generateRandomEmail` and `disableDeleteAnonymousUser: true` are refused. |
| `username` | Core's username and its password sign-in. Needs `emailAndPassword`. The validators and the normalization are refused: core stores NFKC in lower case. |
| `phoneNumber` | Core's phone code. `sendOTP` delivers each code that core makes. Needs `authtempo.phone.regions`. `verifyOTP` and the reset by phone are refused. |
| `oneTap` | Core's ID-token route for Google, with no nonce. Needs `socialProviders.google`. |
| `multiSession` | Core's multi-session, 2 to 10 sessions in one browser. |
| `lastLoginMethod` | Core's last method cookie under Better Auth's cookie name. `storeInDatabase: true` is refused. |
| `jwt`, `mcp`, `cimd`, `oidc-provider`, `oauth-provider` | Refused at start. Move to core's `createAuth` with `jwtMint` and `oauth`. |

Any other plugin is refused at start by its id.

An anonymous user or a phone user has no address. Such a user holds Better Auth's placeholder address in `user.email`, because that column is NOT NULL. The storage reads each placeholder as no address, so core never mails one and never counts one as proved.

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
| `baseURL` takes `{ allowedHosts, fallback, protocol }` with wildcard hosts, and `protocol: "auto"` reads `x-forwarded-proto` | Each host must be exact, and `protocol` must be `https` or `http`; a wildcard, `auto`, and no `protocol` are refused. The hosts map to core's `baseURL` list, and a `fallback` equal to one of them is the primary. Core picks the host from the request URL and reads no proxy header. The shim builds its own paths, SSO URLs, and mail links on that host. Each host is also a trusted origin, as in Better Auth, so a page on one host posts to another. A wildcard on a shared platform lets any customer of the platform own a host of the issuer. |
| The session cookie `better-auth.session_token` | The session cookie `__Host-tempo_session`. For one release the shim also reads `tempo_session`, the name before plan 12b, and the handler moves it. |
| `secrets: [{ version, value }]` accepts version 0 | It maps to core's `secrets`, one entry for one entry. Version 0 is refused: core reads a row from before plan 12b as version 1, so renumber from 1. With `secret`, version 1 must be the value of `secret`. |
| `BETTER_AUTH_SECRETS` in the environment | Not read: the shim maps options only. Pass the list as `secrets`. |
| A secret under 32 characters, or with low entropy, gets a warning | Refused at start. Each value needs 32 characters or more. The current value, `secrets[0]` or `secret`, also needs an estimated 100 bits of entropy. Make one with `openssl rand -base64 32`. |
| `autoSignIn: false` answers `{ token: null, user }` | Refused at start, unless `requireEmailVerification` is true: core opens a session at sign-up without it. With it, the pair acts as `requireEmailVerification` alone, as in Better Auth. |
| A sign-up answers a session unless `requireEmailVerification` is true, and `USER_ALREADY_EXISTS` for a taken address | The same. The shim sets core's `password.uniformSignUp: false`, so a caller can learn that an address has an account, as with Better Auth. |
| `disableSignUp` on each method and provider, and a provider's `disableImplicitSignUp` | Core has one sign-up rule. `true` on every method and social provider that creates a user maps to core's `signUp: false`. A mix is refused at start, with the methods of each group. `disableImplicitSignUp` is refused. `api.signUpEmail` then answers `EMAIL_PASSWORD_SIGN_UP_DISABLED` with 400. The client's `signUp.email` answers the same code with core's status, 403. |

- `toNodeHandler` and `toNextJsHandler` throw `BetterAuthCompatError` at creation for an instance with no `ipAddressHeaders` and no `disableIpTracking: true`.
- `toNodeHandler(auth, { waitUntil })` and `toNextJsHandler(auth, { waitUntil })` take the host's `waitUntil` as a second argument, which Better Auth does not have. On Next, pass `(p) => after(p)` of `next/server`. Without it, a code mail or an SMS runs detached, and a host that stops the function after the answer can drop it.
- A call argument that core cannot keep, such as `rememberMe: false`, answers `APIError` `NOT_SUPPORTED` with status 501.
- `APIError` and the client's `error` carry Better Auth's code and core's HTTP status. `BETTER_AUTH_CODES` is the table.

## The account operations

The shim serves Better Auth 1.7.2's account operations in Better Auth's shapes. Each is a method of `auth.api` and a path of `auth.handler`. The handler posts core's own route for each path, so core's Origin rule, CORS, and cookie renewals apply. The handler runs core's Origin and fetch-metadata rules on every POST first, also on the paths that the shim answers itself. A refused POST answers 403 `{ "code": "INVALID_ORIGIN", "message": "Invalid origin" }`, as Better Auth's origin check does. The check runs before the route, so a refused POST to a path that no route serves answers 403, not 404.

| Better Auth call | Path | Answer |
| --- | --- | --- |
| `listSessions` | `GET /list-sessions` | The live sessions. `token` holds the row id of each session. |
| `revokeSession({ token })` | `POST /revoke-session` | `{ status: true }`, also for an unknown token |
| `revokeSessions` | `POST /revoke-sessions` | `{ status: true }`. Every session ends, the caller's too. |
| `revokeOtherSessions` | `POST /revoke-other-sessions` | `{ status: true }` |
| `updateUser({ name, image })` | `POST /update-user` | `{ status: true }` |
| `changeEmail({ newEmail, callbackURL })` | `POST /change-email` | `{ status: true }` |
| `deleteUser({ password })` | `POST /delete-user` | `{ success: true, message: "User deleted" }`. With `sendDeleteAccountVerification`: `{ success: true, message: "Verification email sent" }` |
| `deleteUser({ token })` | `POST /delete-user` | `{ success: true, message: "User deleted" }`, the confirm of the mailed link |
| `listUserAccounts` | `GET /list-accounts` | The provider accounts and the credential account |
| `linkSocial`, through the handler only | `POST /link-social` | `{ url, redirect }` |
| `unlinkAccount({ accountId })` | `POST /unlink-account` | `{ status: true }` |

The options of these operations:

| Option | Rule |
| --- | --- |
| `session.freshAge` | 1 to 86400 seconds, rounded up to whole minutes. Default one day. `0` is refused: the fresh rule is a promise of core. |
| `session.deferSessionRefresh` | Maps to core's `session.deferRefresh`. A GET writes no session row, and `GET /get-session` answers `needsRefresh`. `POST /get-session` slides the expiry and renews the cookie. |
| `user.changeEmail` | `enabled` turns the change on. It needs `emailVerification.sendVerificationEmail`. `sendChangeEmailConfirmation` and `updateEmailWithoutVerification: true` are refused. |
| `user.deleteUser` | `enabled` turns the delete on, off by default as in Better Auth. `beforeDelete` and `afterDelete` map. `sendDeleteAccountVerification` turns on core's `account.deleteConfirm`, and gets `{ user, url, token }`. `deleteTokenExpiresIn` is a whole number of minutes from 300 to 86400 seconds, default 86400 as in Better Auth. |
| `account.accountLinking` | `enabled: true`, `allowDifferentEmails: false`, and `allowUnlinkingAll: false` are accepted. `trustedProviders`, `updateUserInfoOnLink`, and `disableImplicitLinking` are refused. |
| `emailOTP({ changeEmail })` | `enabled` serves `/email-otp/request-email-change` and `/email-otp/change-email`. `verifyCurrentEmail: true` is refused. |
| `emailOTP({ overrideDefaultEmailVerification })` | `true` is core's `password.verifyBy: "code"`. The sign-up mails a code through `sendVerificationOTP` with the type `email-verification`. `/email-otp/verify-email` and the `email-verification` resend map onto core's sign-up code. |
| `databaseHooks.user`, `databaseHooks.account` | `create`, `update`, and `delete` of a user, and `create` and `delete` of an account, map onto core's hooks. |
| `emailVerification.beforeEmailVerification`, `afterEmailVerification` | Map to `user.beforeVerify` and `user.afterVerify`. Core calls them on each path that proves an unverified address. A change of address calls them too, as in Better Auth 1.7.2. The change link calls the after hook only. The change by code calls the before hook before core's code check. |

Where the shim differs from Better Auth:

| On Better Auth | On authtempo |
| --- | --- |
| `listSessions` answers the clear token of each session | It answers the row id of each session in `token`. The shim stores the hash of a token, never the token. `revokeSession` takes that id or a clear token. |
| A revoke of the caller's own session keeps the cookie | Through the handler, core clears it. |
| Only the list, the unlink, and the delete need a fresh session | A revoke, the change of address, the link, the unlink, and the delete need one. A stale session answers `SESSION_NOT_FRESH` with 403. The list needs none. |
| `/two-factor/disable`, `/two-factor/get-totp-uri`, and `/two-factor/generate-backup-codes` ask for the password only | They also need a fresh session, checked before the password. A stale session answers `SESSION_NOT_FRESH` with 403. |
| A core route answers `{ error: "session_not_fresh" }` | Through the handler, the answer also carries `code: "SESSION_NOT_FRESH"`. |
| `deleteUser({ password })` skips `freshAge` | It re-authenticates first. A wrong password answers `INVALID_EMAIL_OR_PASSWORD`, not `INVALID_PASSWORD`. |
| `GET /delete-user/callback` deletes the account | It serves core's confirm page and deletes nothing, because a mail scanner fetches links. The page posts the token with the session cookie. |
| The request of the mailed link needs no fresh session | It needs one, as the direct delete does. The organization rule runs at the request and again at the confirm. |
| A bad token answers `INVALID_TOKEN` with 404 | It answers `INVALID_TOKEN` with 400. A change of address ends a pending link. |
| `deleteUser` takes a `callbackURL` | It answers `NOT_SUPPORTED` with 501. The confirm page lands on the app. |
| The delete keeps an organization with no owner | An organization where the user is the last owner and other members remain stops the delete: `SOLE_OWNER`, 409. |
| `updateUser` drops a field it does not know | It takes `name` and `image`, for a verified address only. `email` answers `EMAIL_CAN_NOT_BE_UPDATED`. Any other field answers `FIELD_NOT_ALLOWED`. |
| The change link goes to `sendVerificationEmail` and changes the address at once | The link goes to the same callback, to the new address. It opens core's confirm page. A taken address gets no mail, as on Better Auth. |
| A link needs the verified flag or a trusted provider, and an equal address unless `allowDifferentEmails` | A link needs the provider's verified address, equal to the account's. Else the callback answers `email_mismatch`. A provider address must not take an account. |
| The unlink of the last account answers `FAILED_TO_UNLINK_LAST_ACCOUNT` with 400 | The same code with 409, by the last-credential guard. |
| For a user with one account, an unknown id answers `FAILED_TO_UNLINK_LAST_ACCOUNT` | An unknown id answers `ACCOUNT_NOT_FOUND`. |
| The credential account can be unlinked | Its unlink answers `NOT_SUPPORTED` with 501. Core has no password removal. |
| No mail after a credential change | The same. The shim sets core's `account.notices: false`. Use core's `createAuth` for the notice mails. |
| The user delete runs the account delete hooks | It runs none. A credential account fires no account hook, because core's password row is not an identity. |
| `additionalData` of `signIn.social` and `/link-social` reaches `getOAuthState()` | It answers `NOT_SUPPORTED` with 501. The shim serves no `getOAuthState()`, so no shim hook could read the payload. Core's `social.stateData` takes its place: read `stateData` in core's `hooks.session.afterCreate` and `hooks.identity.afterLink`. |

The shim's own codes `EMAIL_CAN_NOT_BE_UPDATED`, `FIELD_NOT_ALLOWED`, `ACCOUNT_NOT_FOUND`, and `CHANGE_EMAIL_DISABLED` answer 400, as on Better Auth.

`GET /get-session` answers `{ session, user }`, or `null` with no session, as on Better Auth. With `session.deferSessionRefresh` off, `POST /get-session` answers `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` with 405, as on Better Auth.

`POST /passkey/update-passkey` and the client's `passkey.updatePasskey({ id, name })` rename a passkey through core's `POST /passkeys/rename`. They answer `{ passkey }`, with the name trimmed, as on Better Auth. The differences:

- The id of another user's passkey answers `PASSKEY_NOT_FOUND` with 404, as an unknown id does. Better Auth answers 401 there. The answer tells nothing about another user's passkeys.
- A name has 1 to 64 characters after the trim, with no control or format character except the zero-width joiners. Else the answer is `VALIDATION_ERROR` with 400.
- The passkey in the answer has no `publicKey`, `counter`, `transports`, or `aaguid`.
- The [limit](/docs/reference/limits/) `passkey-rename:user:<userId>` allows 30 renames per 15 minutes.

## The admin plugin

Better Auth's `admin` plugin runs on core's operator tools (spec section 26). A platform operator is a member of the platform organization with the platform role, a verified address, a second factor, and a fresh session.

| Option | On authtempo |
| --- | --- |
| `authtempo.platformOrganization` | Required with `admin`, refused without it. The slug of the platform organization. |
| `adminRoles` | One role of the organization plugin, default `admin`: a key of its `roles`, or `member`, `admin`, or `owner` with no `roles`. It is the platform role. |
| `impersonationSessionDuration` | Seconds, a whole number of minutes from 5 to 240; default 3600. |
| `defaultRole` | `"user"` only. |
| `allowImpersonatingAdmins` | `false` only. |
| `defaultBanReason`, `defaultBanExpiresIn`, `bannedUserMessage`, `adminUserIds`, `schema`, `ac`, `roles` | Refused at start. |

| Call | On authtempo |
| --- | --- |
| `/admin/set-user-password` | `NOT_SUPPORTED` (501) before any read. No operator sets a password; the person resets it through the reset link. |
| `/admin/list-user-sessions`, `/admin/revoke-user-session`, `/admin/has-permission` | `NOT_SUPPORTED` (501). |
| `/admin/create-user` | Core's `POST /operator/users/create` with `firstSignIn: "none"`, so no mail goes out. It takes `email`, `name`, `data.emailVerified`, and `data.image`, and answers `{ user }`. With `data.emailVerified: true`, core takes the address as proved: no later proof resets the account, so a wrong address gives the account to its owner. Each other key is refused before any read. A `role` that is not a string or a list of strings answers `VALIDATION_ERROR` (400), and a role value that is no string `INVALID_ROLE_TYPE` (400). `password` answers `YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD` (403). A role other than `user` answers `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE` (403). A ban key answers `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS` (403). Any other key of `data` answers `FIELD_NOT_ALLOWED` (400). A taken address answers `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (400), and a malformed address `INVALID_EMAIL` (400). |
| `/admin/update-user` | Core's `POST /operator/users/update`. It takes `data.name` and `data.image` only, and answers the user itself. No `data` answers `NO_DATA_TO_UPDATE`, and `password` answers `PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER`. Then, in Better Auth's order, `role` answers `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE` (403), a ban key `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS` (403), and `email` or `emailVerified` `YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL` (403). Each other key answers `FIELD_NOT_ALLOWED` (400). Each refusal comes before any read. |
| `/admin/remove-user` | Core's `POST /operator/users/delete`. It answers `{ success: true }`. The caller's own id answers `YOU_CANNOT_REMOVE_YOURSELF` (400, as Better Auth), and the last owner of an organization with other members answers `SOLE_OWNER` (409). On the D1 storage a user who alone holds an organization answers `DELETE_TOO_LARGE` (409): delete the organization first. |
| `/admin/list-users` | One search: `searchValue` with `searchOperator: "starts_with"` on the address, or `filterField` `email` or `id`. A search of the name, `contains`, `ends_with`, `sortBy`, and an `offset` other than 0 answer `NOT_SUPPORTED` (501). |
| `/admin/set-role` | The platform role grants it, and `user` revokes it. Any other role answers `NOT_SUPPORTED` (501). |
| `/admin/list-users`, `/admin/get-user` | Core's `GET /operator/users`, `/operator/users/search`, and `/operator/users/get`. The list answers `total` only on a first page that ends the list. A page that does not end the list answers `next`; pass `after` for the next page. |
| `/admin/ban-user`, `/admin/unban-user`, `/admin/set-role` | Core's `POST /operator/users/ban`, `/operator/users/unban`, and `/operator/users/platform-role`. Each answers `{ user }` with `role`, `banned`, `banReason`, and `banExpires`. With `twoFactor()`, the user also has `twoFactorEnabled`. A ban and a `set-role` add `familyEndFailed: true` when the act ran but the end of the OAuth refresh families failed. Then call `/admin/revoke-user-sessions` for the user. |
| `/admin/revoke-user-sessions` | Core's `POST /operator/sessions/end-user`. While sessions stay, it answers `{ success: false, more: true, ended }`: call again. |
| `/admin/impersonate-user`, `/admin/stop-impersonating` | Core's `POST /operator/impersonate` and `/operator/impersonate/stop`. Each answers `{ session, user }`. The stop answers `{ session: null, user: null }` when no operator session comes back. |
| `auth.api` admin calls | `listUsers`, `getUser`, `banUser`, `unbanUser`, `setRole`, `revokeUserSessions`, `impersonateUser`, `stopImpersonating`, `adminUpdateUser`, `removeUser`, and `createUser` run the steps of their paths with the caller's `headers`. A refusal throws `APIError` with the code of the path. A call with no headers has no session and answers 401: the shim makes no app actor. |
| `/get-session` | With `admin`, the user also has `role`, `banned`, `banReason`, and `banExpires`, and the session has `impersonatedBy`. |
| `adminClient()` | The client reads `/get-session`, so `getSession` and `useSession` give the same four fields. |
| `authClient.admin` calls | `listUsers`, `getUser`, `banUser`, `unbanUser`, `setRole`, `revokeUserSessions`, `impersonateUser`, `stopImpersonating`, `updateUser`, `removeUser`, and `createUser` send the mapped paths and answer `{ data, error }`. Dates are `Date` values. |
| `authClient.admin` calls core does not serve | `listUserSessions`, `revokeUserSession`, `setUserPassword`, and `hasPermission` answer `NOT_SUPPORTED` with no request. `checkRolePermission` throws, because core has no permission statements. |

Core's guard decides each mapped call: the platform role, a verified address, a second factor, and a fresh session. Its refusal answers 403 with the code of the path, such as `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS`. An operator cannot act on another platform operator through these calls. An unknown user answers 404 `USER_NOT_FOUND`, and a ban of the caller answers 409 `YOU_CANNOT_BAN_YOURSELF`. An impersonation of the operator, a platform operator, a banned user, or an absent user answers 403 `YOU_CANNOT_IMPERSONATE_ADMINS`. The deviations from Better Auth:

- `/admin/list-users` answers `total` only on a first page that ends the list. An `offset` above 0 is refused, because core pages by a cursor.
- `/admin/revoke-user-sessions` ends one page per call. While sessions stay, it answers `{ success: false, more: true, ended }`.
- A `set-role` of `user` on a platform operator answers 403 `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE`. That revoke needs an operator secret or the app.
- A ban of the caller answers `YOU_CANNOT_BAN_YOURSELF` with 409. Better Auth answers 400.
- `/admin/revoke-user-sessions`, `/admin/unban-user`, and `/admin/set-role` on the caller's own user answer 409 `FORBIDDEN`. Better Auth has no such check there.
- An unknown user answers 404 `USER_NOT_FOUND` on every path. Better Auth answers `{ success: true }` on `/admin/revoke-user-sessions`.
- `/admin/impersonate-user` answers one code, `YOU_CANNOT_IMPERSONATE_ADMINS`, also for an absent user. Better Auth answers `USER_NOT_FOUND` there.
- An impersonation session that starts another one answers 403 `FORBIDDEN`.
- A stop by a session that impersonates nobody answers 400 with the message `You are not impersonating anyone`.
- `/admin/stop-impersonating` answers `{ session: null, user: null }` when no operator session comes back. Better Auth answers 500 there.
- `/admin/create-user` sets no password, no role but `user`, no ban, and no added field. Better Auth sets each one. A server call with no headers answers 401, where Better Auth creates the user.

Each `NOT_SUPPORTED` message names spec section 26. A call with no reason writes the audit reason `better-auth admin plugin <path>`. Compat migration 0009 copies the bans of Better Auth into core's columns. [From Better Auth](/docs/migrate/better-auth/#cut-over) gives the step for the admins.

## Next

- [Move from Better Auth](/docs/migrate/better-auth/)
- [Schema and migrations](/docs/reference/schema/)
- [The cutover](/docs/migrate/cutover/)
