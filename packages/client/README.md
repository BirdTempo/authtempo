# @tempo-auth/client

This package is the app side of tempo-auth. It calls the routes of
`@tempo-auth/core` and returns typed results. It runs in a browser, in
Expo, and in Electron. Its only dependency is `@tempo-auth/core`.

## Install

```sh
pnpm add @tempo-auth/client
```

## Create a client

A browser app sends the session cookie to the API origin.

```ts
import { createClient } from "@tempo-auth/client";

const client = createClient({ baseURL: "https://api.example.com" });
```

A native or desktop app has no cookie. It sends a bearer token.

```ts
const client = createClient({
  baseURL: "https://api.example.com",
  credentials: "omit",
  token: () => store.get(),
});
```

Other options: `basePath` (default `/auth`), `fetch` (default
`globalThis.fetch`), and `webauthn` (the passkey seam). One trailing `/`
on `baseURL` is removed.

### What each kind of app must configure

- A browser app on its own origin needs that origin in the API's
  `trustedOrigins`.
- A browser app on another site also needs `cookie: { sameSite: "None" }`
  on the API. Without it, the browser drops the cookie and `session()`
  answers `null`.
- An untrusted origin makes the browser block the answer. The client then
  reports `network`, not `origin_not_trusted`.
- A native app must pass `credentials: "omit"`. Core reads the cookie
  before the bearer header. A stray cookie in a native cookie jar
  replaces the bearer session.
- When a bearer app gets `null` from `session()`, the token is dead.
  Clear it from the store.

## Operations

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.session()` | `GET /session` | `ClientResult<PublicSession \| null>`. A 401 gives `null`, not a failure. |
| `client.signOut()` | `POST /sign-out` | `ClientResult<{ ok: true }>` |
| `client.magicLink.request({ email, next? })` | `POST /magic-link/request` | `ClientResult<{ sent: true }>` |
| `client.magicLink.verify({ token })` | `POST /magic-link/verify` | `ClientResult<PublicSession>` |
| `client.passkey.register({ name? })` | `POST /passkey/register/options`, then `/passkey/register/verify` | `ClientResult<PasskeySummaryJSON>` |
| `client.passkey.signIn()` | `POST /passkey/authenticate/options`, then `/passkey/authenticate/verify` | `ClientResult<PublicSession>` |
| `client.passkeys.list()` | `GET /passkeys` | `ClientResult<PasskeySummaryJSON[]>` |
| `client.passkeys.delete({ id })` | `POST /passkeys/delete` | `ClientResult<{ ok: true }>` |
| `client.handoff.redeem({ code, verifier })` | `POST /handoff/redeem` | `ClientResult<{ token } & PublicSession>` |

`client.errors` is the error code table of core.

## Results

Every operation returns a `ClientResult`. A success is `{ ok: true, value }`.
A failure is `{ ok: false, code, status }`. The `status` is the HTTP
status, or 0 when no answer arrived.

An operation never throws for an answer. Check `ok` and read `code`.

The `code` is a core error code, or one of three codes that only the
client can see:

| Code | When it appears |
| --- | --- |
| `network` | The fetch rejected. The device is offline, or the host is not reachable. |
| `unexpected` | The answer is not JSON, or its error code is not in the core table. |
| `cancelled` | The person dismissed the passkey prompt, or no authenticator matched. |

## Passkeys

The client reaches WebAuthn through a seam, `BrowserWebAuthn`. The
default seam, `browserWebAuthn()`, calls `navigator.credentials`.

The browser parsers `PublicKeyCredential.parseCreationOptionsFromJSON`
and `parseRequestOptionsFromJSON` came late. The default seam uses them
when they exist. When they are missing, the package converts the options
itself. It also converts the credential back to JSON when `toJSON` is
missing.

Call `supportsPasskeys()` before you show a passkey button. It returns
`false` when the platform has no `PublicKeyCredential`.

A dismissed prompt gives the code `cancelled`. Treat it as a normal
event. Do not show an error.

`unexpected` with status 0 on `register` can mean that the device
already holds a passkey for this account. The browser rejects with
`InvalidStateError` in that case, and the client cannot tell it from
another failure.

## Show the signed-in email

Two one-click lures stay open. The first is a crafted start URL. The
second is a magic link whose `next` is an attacker's continue path. The
confirm page shows the account, but a person can press Continue without
reading it. Show `user.email` after every sign-in, so the person notices
a sign-in to another account.

