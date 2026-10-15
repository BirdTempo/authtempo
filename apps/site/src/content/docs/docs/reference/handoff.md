---
title: The handoff package
description: The options of createHandoff, the opener contract, the Expo and Electron helpers, and the failure codes of @authtempo/handoff.
type: reference
sources:
  - packages/handoff/README.md "createHandoff"
  - packages/handoff/README.md "The opener contract"
  - packages/handoff/README.md "Electron"
  - packages/handoff/README.md "Failure codes"
  - packages/handoff/README.md "The native client"
  - packages/handoff/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
---

**For:** a developer of an Expo app or an Electron app who signs in through the system browser.

**What it does:** this page lists the options, the result, the opener contract, the helpers of each platform, and the failure codes. [Sign in from a native or desktop app](/docs/guides/handoff/) gives the steps.

## Before you start

- Set `handoff.schemes` on the API. [Configuration](/docs/reference/config/) lists the handoff keys.

## createHandoff

`createHandoff(options)` answers a `Handoff`. The type of the options is `HandoffOptions`.

| Option | Default | What it does |
| --- | --- | --- |
| `baseURL` | required | The origin of the API. One trailing `/` is removed. |
| `basePath` | `"/auth"` | The mount path of the routes. |
| `redirect` | required | `<scheme>auth` for a scheme of the API's `handoff.schemes`, or a development URL that `devRedirectPattern` admits. A redirect with `#` is refused. |
| `opener` | required | The browser side, a `HandoffOpener`. |
| `fetch` | `globalThis.fetch` | The fetch of the redeem. |
| `crypto` | `webCrypto()` | The crypto seam, a `HandoffCrypto`. Hermes needs `expoCrypto`. |

- `signIn()` answers a `HandoffResult`: `{ ok: true, value }` with a `HandoffSession` of `{ token, user, session }`, or a `HandoffFailure`.
- `signIn()` is single flight. A second call while one runs gets the result of the first, and the opener runs once.
- `startUrl(challenge)` answers the start URL, for an app that opens the browser itself.

The other exports of the entry:

- `makePkce` makes the verifier and the challenge.
- `parseReturnedUrl` reads the code of a `Returned` URL.
- `base64Url` is the codec of the verifier.
- `HandoffCode` and `Handoff` are types.

## The opener contract

An opener has one method, `open(url, redirect)`.

- It opens `url` in the system browser.
- It resolves with the full URL that the app received on `redirect`.
- It resolves with `null` when the person cancels or the wait ends. The handoff then answers `cancelled`.
- It never resolves with a URL of another flow. One handoff waits at a time.

The returned URL must sit on the configured `redirect`, byte for byte. Otherwise no redeem happens, and the code is `redirect_mismatch`.

## Expo

`@authtempo/handoff/expo` exports `expoOpener(WebBrowser)`, `expoCrypto(Crypto)`, and `expoTokenStore(SecureStore)`.

- Add the app scheme to the `scheme` entry of `app.json`. Without it, the system does not return the code to the app.
- `expoOpener` passes `preferEphemeralSession: false`. An ephemeral session keeps no cookies, so the binding cookie of a social sign-in dies, and the flow answers `invalid_token`.
- `expoCrypto` is required on Hermes. Hermes has no `crypto.subtle`.

## Electron

`@authtempo/handoff/electron` exports `electronOpener`, `createTokenStore`, `asyncSafeStorageCipher`, `safeStorageCipher`, and `TokenStoreError`. Run all of them in the main process.

- `electronOpener({ shell, app })` listens for `open-url` on macOS. On Windows and Linux, forward the URL of `second-instance` to `opener.receive`.
- `createTokenStore({ cipher, read, write, remove })` keeps the token encrypted at rest.
- `asyncSafeStorageCipher(safeStorage)` wraps the async functions of `safeStorage`. Use it in a new app.
- `safeStorageCipher(safeStorage)` wraps the sync functions, for an older app.
- When `safeStorage` has no encryption, `set` throws `TokenStoreError` and writes nothing. On Linux the `basic_text` backend counts as no encryption.
- Call `set` after `app` is ready. Before that, Windows and Linux report no encryption.
- The token stays in the main process. A renderer asks the main process to make requests.

The path of Windows and Linux is not proven. The macOS proof ran on 2026-10-09 with Electron 44.7.0.

## The native client

`createNativeClient(options)` answers a `NativeClient`: a client of the app with `credentials: "omit"` and the stored token as the bearer. The type of the options is `NativeClientOptions`: `baseURL`, `basePath`, `handoff`, `store`, `fetch`, and `webauthn`.

- `signInWithBrowser()` runs the handoff, writes the token to the store, and reads the session.
- `session()` clears the token when it answers `null`.
- A session end clears the token only when the store still holds the token that the request sent. A newer token stays.
- `signOut()` clears the token when the server ended the session or did not know it.
- A store write that throws in `signInWithBrowser()` answers `unexpected`. A read that throws sends no token, and a clear that throws is skipped. Nothing throws for an answer.
- A password sign-in, an email code verify, and a second factor verify answer a token that the native client does not keep. Write it with `store.set`.

A `TokenStore` has `get`, `set`, and `clear`. On Electron, `createTokenStore` answers a `TokenStore`.

`expoTokenStore(SecureStore)` keeps the token through `expo-secure-store`, whose part it calls is `SecureStoreLike`.

- A key holds letters, digits, `.`, `-`, and `_` only. The default is `authtempo.session`.
- A read that throws, as a locked keychain does, answers `null` and keeps the entry.
- `secureStoreOptions`, a `SecureStoreOptionsLike`, goes to each call of `expo-secure-store`.

## Exports

| Entry | Exports |
| --- | --- |
| `@authtempo/handoff` | `createHandoff`, `Handoff`, `HandoffOptions`, `HandoffOpener`, `HandoffResult`, `HandoffSession`, `HandoffFailure`, `HandoffCode`, `makePkce`, `webCrypto`, `base64Url`, `HandoffCrypto`, `parseReturnedUrl`, `Returned`, `HANDOFF_CALLS`, `createNativeClient`, `NativeClient`, `NativeClientOptions`, `TokenStore` |
| `@authtempo/handoff/expo` | `expoOpener`, `ExpoWebBrowserLike`, `expoCrypto`, `ExpoCryptoLike`, `expoTokenStore`, `SecureStoreLike`, `SecureStoreOptionsLike`, `TokenStore` |
| `@authtempo/handoff/electron` | `electronOpener`, `ElectronOpener`, `ElectronShellLike`, `ElectronAppLike`, `createTokenStore`, `TokenStore`, `TokenStoreError`, `TokenCipher`, `CipherOptions`, `safeStorageCipher`, `SafeStorageLike`, `asyncSafeStorageCipher`, `AsyncSafeStorageLike` |

`HANDOFF_CALLS` is the table of the route that the handoff builds a URL for: `GET /handoff/start`, which the system browser opens. The redeem is the call `handoff.redeem` of the client.

`makePkce`, `webCrypto`, `base64Url`, `parseReturnedUrl`, and `Returned` live in [the OAuth client entry](/docs/reference/client-oauth/). `HandoffCrypto` is its `PkceCrypto`. This package re-exports them for one release.

## Failure codes

| Code | Meaning |
| --- | --- |
| `cancelled` | The person closed the browser, or the wait ended. |
| `redirect_mismatch` | The returned URL is not on the configured `redirect`. No redeem happened. The Electron opener drops such a URL and waits on. |
| A core code | The codes of the server pass through, such as `invalid_token`, `token_expired`, and `rate_limited`. |
| `network`, `unexpected` | The same as in [the client package](/docs/reference/client/). |

## Next

- [Sign in from a native or desktop app](/docs/guides/handoff/)
- [The client package](/docs/reference/client/)
- [Tokens and prefixes](/docs/reference/tokens/)
