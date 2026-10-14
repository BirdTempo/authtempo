---
title: Better Auth compatibility
description: The package aliases, the plugins, and the options that @authtempo/compat-better-auth keeps or refuses at start.
type: reference
sources:
  - packages/compat-better-auth/README.md "The alias"
  - packages/compat-better-auth/README.md "What fails at start"
  - packages/compat-better-auth/README.md "Plugins"
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
| `emailOTP` | Core's email codes, for the sign-in and the reset. `sendVerificationOTP` is required. |
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
| `autoSignIn: false` answers `{ token: null, user }` | Refused at start: core opens a session at sign-up unless `requireEmailVerification` is true. |
| A sign-up answers a session, and `USER_ALREADY_EXISTS` for a taken address | The same. The shim sets core's `password.uniformSignUp: false`, so a caller can learn that an address has an account, as with Better Auth. |
| `disableSignUp` on each method | Core has one sign-up rule. `true` on every method that creates a user, with no social provider, maps to core's `signUp: false`. A mix is refused at start. `api.signUpEmail` then answers `EMAIL_PASSWORD_SIGN_UP_DISABLED` with 400. |

- `toNodeHandler` and `toNextJsHandler` throw `BetterAuthCompatError` at creation for an instance with no `ipAddressHeaders` and no `disableIpTracking: true`.
- A call argument that core cannot keep, such as `rememberMe: false`, answers `APIError` `NOT_SUPPORTED` with status 501.
- `APIError` and the client's `error` carry Better Auth's code and core's HTTP status. `BETTER_AUTH_CODES` is the table.

## Next

- [Move from Better Auth](/docs/migrate/better-auth/)
- [Schema and migrations](/docs/reference/schema/)
- [The cutover](/docs/migrate/cutover/)
