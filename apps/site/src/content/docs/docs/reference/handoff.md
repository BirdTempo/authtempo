---
title: The handoff package
description: The options of createHandoff, the opener contract, the Expo and Electron helpers, and the failure codes of @authtempo/handoff.
type: reference
sources:
  - packages/handoff/README.md "createHandoff"
  - packages/handoff/README.md "The opener contract"
  - packages/handoff/README.md "Electron"
  - packages/handoff/README.md "Failure codes"
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

`@authtempo/handoff/expo` exports `expoOpener(WebBrowser)` and `expoCrypto(Crypto)`.

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
