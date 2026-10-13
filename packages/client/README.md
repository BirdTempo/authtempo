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

The password operations are in the Passwords section.

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

## Passwords

Every password operation answers `not_found` when the server runs
without the `password` config.

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.password.signUp({ email, password, name? })` | `POST /password/sign-up` | `ClientResult<{ token } & PublicSession>` |
| `client.password.signIn({ email, password })` | `POST /password/sign-in` | `ClientResult<{ token } & PublicSession>` |
| `client.password.resendVerification({ email })` | `POST /password/verify/resend` | `ClientResult<{ sent: true }>` |
| `client.password.verifyEmail({ token })` | `POST /password/verify` | `ClientResult<{ verified: true }>`; the cookie is set when the address was unverified |
| `client.password.requestReset({ email, next? })` | `POST /password/reset/request` | `ClientResult<{ sent: true }>` |
| `client.password.reset({ token, password })` | `POST /password/reset` | `ClientResult<{ token } & PublicSession>` |
| `client.password.change({ currentPassword?, newPassword })` | `POST /password/change` | `ClientResult<{ ok: true }>` |

The client has no token store. `signUp`, `signIn`, and `reset` answer the
bearer token. A browser app ignores it, because the cookie carries the
session. A native app stores the token in its own store and returns it
from the `token` option. An Electron app can use `createTokenStore` from
`@tempo-auth/handoff`.

The password goes in the request body only. It never goes in a URL.

## API tokens

A CLI or a script uses an API token that a person made in the app.
`create`, `list`, and `revoke` need a session; a token answers
`unauthorized` there, so a token cannot mint a token. `current` needs a
token. The clear token appears once, in the `create` answer.

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.tokens.create({ name, expiresInDays?, organizationId? })` | `POST /tokens` | `ClientResult<{ token, apiToken: ApiTokenSummaryJSON }>` |
| `client.tokens.list()` | `GET /tokens` | `ClientResult<ApiTokenSummaryJSON[]>` |
| `client.tokens.revoke({ id })` | `POST /tokens/revoke` | `ClientResult<{ ok: true }>` |
| `client.tokens.current()` | `GET /tokens/current` | `ClientResult<{ user, apiToken }>` |

A CLI passes the token as the bearer: `createClient({ baseURL, credentials: "omit", token: () => process.env.TEMPO_TOKEN ?? null })`.
`expiresInDays` is 1 to 3650, default 90; `null` means no expiry.

## Connected apps

The OAuth grants of the signed-in person (plan 9g), for a page that lists
the agents and apps with access and ends one. Both calls need a session; a
token answers `unauthorized`. Both answer `not_found` when the server runs
without `oauth`.

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.oauth.grants()` | `GET /oauth/grants` | `ClientResult<OAuthGrantJSON[]>`: `clientId`, `clientName`, `scopes`, `createdAt`, `refreshTokens` |
| `client.oauth.revoke({ clientId })` | `POST /oauth/grants/revoke` | `ClientResult<{ ok: true }>` |

`revoke` deletes the consent and every refresh token of the client, and
answers `{ ok: true }` also when the client had none. An access token that
the client holds lives on to its `exp`, at most `oauth.accessTtlMinutes`.

## Organizations

The server must set `organizations: {}` in `createAuth`. Without it, each
operation below answers `not_found`.

Every operation needs a session. The exception is `invitations.decline`,
which needs only the token. All dates in the answers are ISO strings.
Each `member` in an answer has the type `MemberJSON`: `id`, `userId`,
`role`, `email`, `name`, and `createdAt`. The `create` answer uses the
same type.

| Operation | Route | Answer |
| --- | --- | --- |
| `organizations.create({ slug, name, metadata? })` | `POST /organizations/create` | `{ organization, member }` |
| `organizations.list()` | `GET /organizations` | list of `{ organization, role }` |
| `organizations.update({ organizationId, name?, slug?, metadata? })` | `POST /organizations/update` | the organization |
| `organizations.delete({ organizationId })` | `POST /organizations/delete` | `{ ok: true }` |
| `organizations.members.list({ organizationId })` | `GET /organizations/members` | list of members |
| `organizations.members.add({ organizationId, userId, role })` | `POST /organizations/members/add` | the member |
| `organizations.members.role({ organizationId, userId, role })` | `POST /organizations/members/role` | the member |
| `organizations.members.remove({ organizationId, userId })` | `POST /organizations/members/remove` | `{ ok: true }` |
| `organizations.invitations.invite({ organizationId, email, role })` | `POST /organizations/invite` | the invitation |
| `organizations.invitations.list({ organizationId })` | `GET /organizations/invitations` | list of invitations |
| `organizations.invitations.revoke({ organizationId, invitationId })` | `POST /organizations/invitations/revoke` | `{ ok: true }` |
| `organizations.invitations.accept({ token })` | `POST /organizations/invitations/accept` | `{ organization, member }` |
| `organizations.invitations.decline({ token })` | `POST /organizations/invitations/decline` | `{ ok: true }` |
| `organizations.setActive({ organizationId })` | `POST /organizations/active` | the session |

The server sends each invitation by mail. The token is only in the mail.
The answer to `invite` has no token, and the inviter never sees it. The
person who gets the mail passes the token to `accept` or `decline`.

`setActive` answers the session. Read `session.activeOrganizationId` in
the answer. Pass `organizationId: null` to clear the active organization.

If you omit `metadata`, the client does not send the key. Pass `null` to
`update` to clear the metadata of an organization.

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

