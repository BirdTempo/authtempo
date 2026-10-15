# @authtempo/client

This package is the app side of authtempo. It calls the routes of
`@authtempo/core` and returns typed results. It runs in a browser, in
Expo, and in Electron. Its only dependency is `@authtempo/core`.

## Install

```sh
pnpm add @authtempo/client
```

## Create a client

A browser app sends the session cookie to the API origin.

```ts
import { createClient } from "@authtempo/client";

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

## The route table

`CLIENT_CALLS` lists every route that the client calls: the operation,
the method, and the path. The client takes each path from it. Its type
holds each path to `ROUTES` of `@authtempo/core/routes`, so a path that
core does not serve fails the compile. `createTransport` gives the same
typed call to your own code. A query goes in the fourth argument, and
more request headers go in the fifth.

## The session store

`client.store` holds the session for a page. Its state is
`{ data, error, isPending, isRefetching }`.

- `store.subscribe(listener)` adds a listener. The first one starts the
  first read. It answers the function that removes the listener.
- `store.get()` answers the state. The object stays the same until the
  next change.
- `store.refetch()` reads the session again.
- The store reads again after each sign-in and after the sign-out.
- It reads again after the second factor verify and enable, a password
  reset or change, and the address verify.
- It reads again after the active organization changes, after an
  organization delete or a member remove, and after the handoff redeem.
- It reads again when another tab of the origin changes the session, and
  when the page becomes visible. It does not poll.

## Operations

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.session()` | `GET /session` | `ClientResult<PublicSession \| null>`. A 401 gives `null`, not a failure. |
| `client.signOut()` | `POST /sign-out` | `ClientResult<{ ok: true }>` |
| `client.readRedirectError(url)` | none | The code of `?auth_error=<code>`: an `ErrorCode` or an `OAuthErrorCode`, because core's OAuth sign-in route sends a code of `OAUTH_ERRORS`. `unexpected` for a code that neither table has, or `null` |
| `client.social.startURL({ provider, next? })` | `GET /social/:provider/start` (built, not fetched) | `ClientResult<string>`; `invalid_body` with status 0 for a name that core refuses |
| `client.social.signIn({ provider, next? })` | `GET /social/:provider/start` (a navigation) | `ClientResult<{ url }>`; `unexpected` with status 0 when the default `navigate` finds no `location` |
| `client.signIn.password({ email, password, trustDevice?, next?, captchaToken? })` | `POST /password/sign-in`, then `POST /totp/verify` through `verify` | `ClientResult<PasswordSignIn>`. The second factor step has `methods`, and `verify` takes `{ code }`, `{ backupCode }`, or `{ emailCode }`. For the passkey method, call `secondFactor.passkey.verify` |
| `client.magicLink.request({ email, next? })` | `POST /magic-link/request` | `ClientResult<{ sent: true }>` |
| `client.magicLink.verify({ token, trustDevice? })` | `POST /magic-link/verify` | `ClientResult<PublicSession \| TwoFactorChallengeJSON>` |
| `client.passkey.register({ name? })` | `POST /passkey/register/options`, then `/passkey/register/verify` | `ClientResult<PasskeySummaryJSON>` |
| `client.passkey.signIn({ autofill? })` | `POST /passkey/authenticate/options`, then `/passkey/authenticate/verify` | `ClientResult<PublicSession>`. With `autofill: true` the browser waits for the autofill of a field with `autocomplete="username webauthn"`; with no conditional mediation it answers `cancelled` and sends nothing |
| `client.passkey.abort()` | none | Ends a waiting passkey ceremony, which answers `cancelled`. A new passkey ceremony also ends the waiting one, because a browser refuses a second pending request |
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
| `unexpected` | The answer is not JSON, or its error code is not in the core table. A session read or a handoff redeem that answers 200 with a body of another shape gives `unexpected` with status 200. |
| `cancelled` | The person dismissed the passkey prompt, or no authenticator matched. |

## Error texts

`errorText(code)` answers one sentence for a code, for an app to show to
a person. `errorDocsURL(code)` answers the docs page of the code. For a
code of a core table, that is its anchor on the error codes page. For
`network`, `unexpected`, and `cancelled`, it is the results section of
the client page. `redirect_mismatch`
links to the failure codes of the handoff page. Pass `"oauth"` as the
second argument for a code of the OAuth client, because `invalid_token`
and `rate_limited` are in both tables. `ERROR_TEXT` holds every text, by
table.

`errorText(code, locale)` answers the text in a language of `LOCALES`.
English (`"en"`) is the default and the only language of the list. For a
code of the OAuth client, the locale is the third argument:
`errorText(code, "oauth", locale)`. `resolveLocale(navigator.language)`
picks the locale of a language tag, else English. The docs link of a
code is the same in every language.

```ts
import { errorDocsURL, errorText } from "@authtempo/client";

const r = await client.signOut();
if (!r.ok) show(errorText(r.code), errorDocsURL(r.code));
```

## Passwords

Every password operation answers `not_found` when the server runs
without the `password` config.

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.password.signUp({ email, password, name? })` | `POST /password/sign-up` | `ClientResult<{ token } & PublicSession>` |
| `client.password.signIn({ email, password, trustDevice?, next? })` | `POST /password/sign-in` | `ClientResult<({ token } & PublicSession) \| TwoFactorChallengeJSON>` |
| `client.password.resendVerification({ email })` | `POST /password/verify/resend` | `ClientResult<{ sent: true }>` |
| `client.password.verifyEmail({ token })` | `POST /password/verify` | `ClientResult<{ verified: true }>`; the cookie is set when the address was unverified |
| `client.password.requestReset({ email, next? })` | `POST /password/reset/request` | `ClientResult<{ sent: true }>` |
| `client.password.reset({ token, password, trustDevice? })` | `POST /password/reset` | `ClientResult<({ token } & PublicSession) \| TwoFactorChallengeJSON>` |
| `client.password.change({ currentPassword?, newPassword })` | `POST /password/change` | `ClientResult<{ ok: true }>` |

The client has no token store. `signUp`, `signIn`, and `reset` answer the
bearer token. A browser app ignores it, because the cookie carries the
session. A native app stores the token in its own store and returns it
from the `token` option. An Electron app can use `createTokenStore` from
`@authtempo/handoff`.

The password goes in the request body only. It never goes in a URL.

## Email codes

Every operation answers `not_found` when the server sets `emailOtp: false`.
The two reset operations also answer `not_found` without the `password`
config.

| Operation | Route | Answer type |
| --- | --- | --- |
| `client.emailOtp.request({ email })` | `POST /otp/request` | `ClientResult<{ sent: true }>` |
| `client.emailOtp.verify({ email, code, trustDevice? })` | `POST /otp/verify` | `ClientResult<({ token } & PublicSession) \| TwoFactorChallengeJSON>` |
| `client.emailOtp.requestReset({ email })` | `POST /otp/reset/request` | `ClientResult<{ sent: true }>` |
| `client.emailOtp.reset({ email, code, password, trustDevice? })` | `POST /otp/reset` | `ClientResult<({ token } & PublicSession) \| TwoFactorChallengeJSON>` |

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

## The OAuth client

`@authtempo/client/oauth` signs a third-party app in to an authtempo OAuth provider. The app can be a native app, a CLI with a loopback redirect, or the server side of a web app. A single-page app on its own registered origin can use it too.

1. Register the app once with `registerOAuthClient({ issuer, clientName, redirectUris })`, or have the owner register it. Keep the `clientId`.
2. `createOAuthClient({ issuer, clientId, redirectUri, resource, scopes })`. A single-page app passes `pending: browserPendingStore()`.
3. Open the URL of `authorizeURL()`. The person signs in and allows the app.
4. Pass the URL that the redirect brings back to `handleRedirect(url)`. It checks `state` and `iss`, then answers the tokens.
5. `refresh(refreshToken)` answers new tokens. `revoke(refreshToken)` ends the grant.

Every answer is an `OAuthResult`: `{ ok: true, value }` or `{ ok: false, code, status }`, where `code` is an `OAuthClientCode`. A `state` or an `iss` that no sign-in of this client started answers `redirect_mismatch`.

A single-page app on another origin needs that origin in a redirect URI of its client. The token request is a form post with no other header, so the browser sends no preflight. The register, revoke, and userinfo endpoints have no CORS for another origin.

The issuer must have no user info. An `http` issuer is for a loopback host in development.
Each new sign-in removes the pending sign-ins that are older than 10 minutes.

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

For passkey autofill, start the autofill when the page loads, before a
passkey button can run. A new passkey ceremony ends a waiting one, also
a register.

`unexpected` with status 0 on `register` can mean that the device
already holds a passkey for this account. The browser rejects with
`InvalidStateError` in that case, and the client cannot tell it from
another failure.

## The second factor

A sign-in, a reset, a magic link, an email code, and social can answer `{ twoFactor: { challenge, expiresAt, methods } }` for a user with the second factor on. `methods` lists what passes, in this order: `passkey`, `totp`, `email`, `backup`.

Every call but `totp.verify`, `secondFactor.passkey.verify`, and `secondFactor.email.send` needs a session. A token answers `unauthorized` there. Every call answers `not_found` when the server runs without `password` or with `totp: false`. The passkey calls also answer `not_found` without the `passkey` config.

| Call | Does |
| --- | --- |
| `totp.setup({ password })` | Answers the secret, the key URI, and the backup codes, each once. The codes are empty when another method is on. |
| `totp.enable({ code })` | Turns TOTP on with a current code. Answers `TotpStatusJSON`. |
| `totp.verify({ challenge, code?, backupCode?, emailCode?, trustDevice? })` | Passes a challenge with one proof. Answers `TwoFactorSessionJSON`. |
| `totp.disable({ code })` | Turns TOTP off with a current code or a backup code. |
| `totp.regenerateBackupCodes({ code })` | Answers a new list of backup codes. The old codes stop working. |
| `totp.status()` | Answers `TotpStatusJSON`, with `methods` and `backupCodesVersion`. |
| `totp.revokeTrustedDevices()` | Deletes every trusted device of the user. |
| `secondFactor.passkey.enable({ password })` | Asks the browser for a passkey, then turns the passkey method on. |
| `secondFactor.passkey.verify({ challenge, trustDevice? })` | Passes a challenge with a passkey. |
| `secondFactor.email.enable({ password })` | Turns the email method on. |
| `secondFactor.email.send({ challenge })` | Mails a code; pass it as `totp.verify({ challenge, emailCode })`. |
| `secondFactor.disable({ method, password })` | Turns the passkey or the email method off. |

The calls of the second factor can answer these codes: `invalid_credentials`, `email_unverified` (403), `invalid_code`, `too_many_attempts`, `passkey_failed`, `invalid_body` (the challenge offers no such method), `invalid_token`, `totp_enabled`, `totp_not_enabled` (the method is off), `rate_limited`, `conflict`, `not_found`, and `unauthorized`. A dismissed passkey prompt answers `cancelled`.

## Show the signed-in email

Two one-click lures stay open. The first is a crafted start URL. The
second is a magic link whose `next` is an attacker's continue path. The
confirm page shows the account, but a person can press Continue without
reading it. Show `user.email` after every sign-in, so the person notices
a sign-in to another account.

