# @authtempo/handoff

This package signs in a native or desktop app through the system
browser. It does the app side of the handoff of `@authtempo/core`. It
has two adapters, one for Expo and one for Electron. It does not depend
on Expo or Electron. Its only dependencies are `@authtempo/client` and
`@authtempo/core`.

## The flow

1. The app makes a PKCE verifier and its S256 challenge.
2. The app opens the system browser at the start URL, with the challenge
   and the redirect.
3. The person signs in. The API redirects to the redirect with a one-time
   code.
4. The app redeems the code with the verifier and receives a bearer
   token.

The opener does steps 2 and 3. The package does steps 1 and 4. The
verifier leaves the process once, in the redeem body.

## createHandoff

```ts
import { createHandoff } from "@authtempo/handoff";

const handoff = createHandoff({
  baseURL: "https://api.example.com",
  redirect: "consumera://auth",
  opener,
});
const result = await handoff.signIn();
```

| Option | Meaning |
| --- | --- |
| `baseURL` | The API origin. One trailing `/` is removed. |
| `basePath` | The mount path of the auth routes. Default `/auth`. |
| `redirect` | `<scheme>auth`, where `<scheme>` is an entry of the API's `handoff.schemes` with its `://`. For `schemes: ["consumera://"]` the redirect is `consumera://auth`. Or a development URL that `devRedirectPattern` admits. A redirect that contains `#` is refused. |
| `opener` | The browser side. See the next section. |
| `fetch` | The fetch to use. Default `globalThis.fetch`. |
| `crypto` | The crypto seam. Default Web Crypto. Hermes needs `expoCrypto`. |

`signIn()` returns `{ ok: true, value: { token, user, session } }` or a
failure. `signIn()` is single flight. A second call while one runs gets
the result of the first call, and the opener runs once. `startUrl(challenge)` returns the start URL for apps that open
the browser themselves.

## The opener contract

An opener has one method: `open(url, redirect)`.

- It opens `url` in the system browser.
- It resolves with the full URL that the app received on `redirect`.
- It resolves with `null` when the person cancels or the wait ends. The
  handoff then returns the code `cancelled`.
- It never resolves with a URL from another flow. One handoff waits at a
  time.
- A URL on the redirect from another flow ends the wait. The redeem then
  fails with `invalid_token`. The protocol has no state value that an
  opener could match.

The returned URL must sit on the configured `redirect`, byte for byte.
If it does not, no redeem happens and the code is `redirect_mismatch`.

## Expo

```ts
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { createHandoff } from "@authtempo/handoff";
import { expoCrypto, expoOpener } from "@authtempo/handoff/expo";

const handoff = createHandoff({
  baseURL: "https://api.example.com",
  redirect: "consumera://auth",
  opener: expoOpener(WebBrowser),
  crypto: expoCrypto(Crypto),
});
```

- Add the app scheme to `app.json`, in the `scheme` entry. Without it,
  the system does not return the code to the app.
- `expoOpener` passes `preferEphemeralSession: false`. An ephemeral
  session keeps no cookies. The social binding cookie then dies between
  the provider start and its callback, and the flow fails with
  `invalid_token`. Do not change this option.
  Unconfirmed on 2026-10-10: no phone has tested this claim. Step 8 of
  `docs/superpowers/runbooks/2026-10-10-expo-cookie-proof.md` settles it.
- `expoCrypto` is required on Hermes. Hermes has no `crypto.subtle`.

## Electron

Run all of this in the main process.

```ts
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import { createClient } from "@authtempo/client";
import { createHandoff } from "@authtempo/handoff";
import { asyncSafeStorageCipher, createTokenStore, electronOpener } from "@authtempo/handoff/electron";

// Without the lock, Windows and Linux start a second app, and the sign-in waits until the timeout.
// `app.quit()` does not stop this script, so the losing instance must return here.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

async function main() {
  app.setAsDefaultProtocolClient("consumera");

  const opener = electronOpener({ shell, app });
  app.on("second-instance", (_event, argv) => {
    opener.receive(argv.find((a) => a.startsWith("consumera://")) ?? "");
  });

  const file = join(app.getPath("userData"), "token.bin");
  const store = createTokenStore({
    cipher: asyncSafeStorageCipher(safeStorage),
    // The bytes of the file, or null when there is no file.
    read: () =>
      readFile(file).catch((e: NodeJS.ErrnoException) =>
        e.code === "ENOENT" ? null : Promise.reject(e),
      ),
    write: (bytes) => writeFile(file, bytes),
    remove: () =>
      unlink(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      }),
  });

  const baseURL = "https://api.example.com";
  const client = createClient({ baseURL, credentials: "omit", token: () => store.get() });
  const handoff = createHandoff({ baseURL, redirect: "consumera://auth", opener });

  await app.whenReady();
  const result = await handoff.signIn();
  if (result.ok) await store.set(result.value.token);
}
```

- Call `app.requestSingleInstanceLock()` before anything else. Without
  the lock, `second-instance` never fires on Windows and Linux. The
  first app waits until the timeout and answers `cancelled`.
- Call `app.setAsDefaultProtocolClient` so the system routes the scheme
  to the app. On Windows, an unpackaged app in development must pass
  `process.execPath` as the second argument and the script path inside
  the `args` array as the third:
  `app.setAsDefaultProtocolClient("consumera", process.execPath, [resolve(process.argv[1])])`.
- macOS delivers the URL as an `open-url` event. The opener listens for
  it.
- Windows and Linux start a second instance with the URL in `argv`.
  Forward it from the `second-instance` handler to `opener.receive`.
- `createTokenStore({ cipher, read, write, remove })` keeps the token
  encrypted at rest. `read` returns the stored bytes, or `null` when there
  are none. `write` stores the bytes. `remove` deletes them and ignores a
  missing file. The Electron `safeStorage` page says the sync functions
  "may be deprecated in a future version" (checked 2026-10-10); use the
  async cipher in a new app. `safeStorageCipher(safeStorage)` wraps the
  sync functions for an older app.
- If `safeStorage` has no encryption, `set` throws `TokenStoreError` and
  writes nothing. On Linux the `basic_text` backend counts as no
  encryption, because its password is public. On Linux a missing
  `getSelectedStorageBackend` also counts as no encryption. Both helpers
  take `{ platform }` as a second argument; the default is
  `process.platform`. A plaintext token on disk is worse than a new sign-in.
- Call `set` after `app` is ready. Before `ready`, Windows and Linux
  report no encryption, and `set` throws.
- The token stays in the main process. A renderer asks the main process
  to make requests. The renderer never holds the token.
- Proven at 2026-10-09T21:11:30Z on macOS 27.0 with Electron 44.7.0:
  `open-url` and `second-instance` both
  delivered the code, the token store kept the token encrypted, and the
  opener dropped a URL off the redirect. The proof used a copy of the
  Electron bundle with the scheme in `Info.plist` and `lsregister -f`.
  `second-instance` is proven on macOS only. The path for Windows and
  Linux is not proven. The record is
  `examples/electron/proof/results/electron-macos.json`. A run leaves a
  LaunchServices handler preference for `example-app` after the bundle
  is gone; the proof records it.
- Observation on 2026-10-10: the plain unpackaged app also received
  `open-url` on macOS 27.0. The Electron 44.7.0 docs say it should fail.
  Every Electron development binary shares one bundle id, so do not rely on
  this path. Declare the scheme in the bundle.

## The native client

`createNativeClient({ baseURL, handoff, store })` answers a client for a native or desktop app in one call. It sends the stored token as the bearer and no cookie.

- `signInWithBrowser()` runs the handoff, writes the token to the store, and reads the session.
- `session()` clears the token when it answers `null`: the token is dead.
- `signOut()` clears the token when the server ended the session or did not know it.
- A store that throws answers `unexpected`. Nothing throws for an answer.

On Expo, the store is `expoTokenStore(SecureStore)` of `@authtempo/handoff/expo`, on the iOS Keychain or the Android Keystore through `expo-secure-store`. A key holds letters, digits, `.`, `-`, and `_` only; the default is `authtempo.session`. On Electron, the store is `createTokenStore` of `@authtempo/handoff/electron`.

```ts
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { createHandoff, createNativeClient } from "@authtempo/handoff";
import { expoCrypto, expoOpener, expoTokenStore } from "@authtempo/handoff/expo";

const baseURL = "https://api.example.com";
const handoff = createHandoff({
  baseURL,
  redirect: "consumera://auth",
  opener: expoOpener(WebBrowser),
  crypto: expoCrypto(Crypto),
});
export const client = createNativeClient({ baseURL, handoff, store: expoTokenStore(SecureStore) });
```

## Development

Core admits a development redirect only when the API sets
`devRedirectPattern`. For Expo Go the redirect is an `exp://` URL. For
a web or desktop test it is a loopback URL, for example
`http://127.0.0.1:8081/auth`. Core refuses any `http` or `https` URL
that is not on a loopback host.

The handoff confirm page adds the source of the matched dev redirect to
`form-action`: its scheme (`exp:`), or the origin of a loopback URL
(`http://127.0.0.1:8081`). A dev redirect on `[::1]` cannot be listed.
Use `127.0.0.1`.

## Failure codes

| Code | Meaning |
| --- | --- |
| `cancelled` | The person closed the browser, or the wait ended. |
| `redirect_mismatch` | The returned URL is not on the configured `redirect`. No redeem happened. In Electron the opener drops a URL off the redirect, so this code does not appear there and the wait continues. |
| Core codes | The server's codes pass through, for example `invalid_token`, `token_expired`, `rate_limited`. |
| `network`, `unexpected` | The same as in `@authtempo/client`. |

## Show the signed-in email

Two one-click lures stay open. The first is a crafted start URL. The
second is a magic link whose `next` is an attacker's continue path. The
confirm page shows the account, but a person can press Continue without
reading it. Show `user.email` after every sign-in, so the person notices
a sign-in to another account.

