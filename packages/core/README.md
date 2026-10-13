# @tempo-auth/core

```ts
import { createAuth, createMemoryAdapter } from "@tempo-auth/core";

const auth = createAuth({
  baseURL: "https://api.example.com",
  secret: env.AUTH_SECRET,                 // at least 32 characters
  trustedOrigins: ["https://app.example.com", "consumera://"],
  storage: createMemoryAdapter(),          // use a D1 or Postgres adapter in production
  mail: { send: async (m) => { /* your transport */ } },
});

// In your fetch handler:
if (url.pathname.startsWith("/auth/")) return auth.handle(request);
const s = await auth.session(request);     // { user, session } or null
```

## Routes under `basePath` (default `/auth`)

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| POST | `/magic-link/request` | `{ email, next? }` | `{ sent: true }` always; 429 when rate limited; 400 on a bad body |
| GET | `/magic-link/verify` | `?token=` | 200 HTML confirm page with a form that posts the token; 302 to `/?auth_error=invalid_token` on a malformed token. No side effect, so a mail scanner burns nothing |
| POST | `/magic-link/verify` | form or JSON `token` | form body: 302 to `appURL` plus `next` with the session cookie, or 302 to `/?auth_error=<code>`; JSON body: 200 `{ user, session }` with the cookie, or the error as JSON |
| GET | `/social/google/start`, `/social/apple/start` | `?next=` | 302 to the provider with a binding cookie; 302 to `/?auth_error=rate_limited` when limited. A route exists only for a configured provider |
| GET | `/social/google/callback` | `?code&state` | 302 to `next` with the session cookie; 302 to `/?auth_error=<code>` on failure |
| POST | `/social/apple/callback` | form `code, state, user?` from Apple | same as the Google callback. The Origin check is skipped here; the state row and the binding cookie bind the post |
| GET | `/social/<name>/start`, `/social/<name>/callback` | `?next=`; `?code&state` | the same answers as the Google routes, for `github`, `linkedin`, and each `social.oidc` and `social.oauth2` entry |
| GET | `/session` | cookie or `Authorization: Bearer` | `{ user, session }` or 401 |
| POST | `/sign-out` | cookie or bearer | `{ ok: true }` and clears the cookie |
| POST | `/passkey/register/options` | session | the creation options JSON for `navigator.credentials.create`; 401; 403 `email_unverified` |
| POST | `/passkey/register/verify` | session, `{ response, name? }` | `{ passkey }`; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed`; 401; 403 `email_unverified`. A credential id that is already registered answers `passkey_failed` |
| POST | `/passkey/authenticate/options` | `{}` | the request options JSON for `navigator.credentials.get`; 429 `rate_limited` |
| POST | `/passkey/authenticate/verify` | `{ response }` | `{ user, session }` with the session cookie; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed` (an unknown credential or a bad signature); 429 `rate_limited` |
| GET | `/passkeys` | session | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, createdAt }] }`; 401 |
| POST | `/passkeys/delete` | session, `{ id }` | `{ ok: true }`; 400 `invalid_body`; 401; 404 `not_found` |
| POST | `/password/sign-up` | `{ email, password, name? }` | `{ token, user, session }` with the cookie; 400 `invalid_body`, `password_policy`, `password_breached`; 409 `email_taken`, `email_taken_unverified`; 429 `rate_limited`. The user is unverified until the mail link is confirmed |
| POST | `/password/sign-in` | `{ email, password }` | `{ token, user, session }` with the cookie; 400 `invalid_body`; 401 `invalid_credentials`; 429 `rate_limited`; 404 without a `password` config |
| GET | `/password/verify` | `?token=` | 200 HTML confirm page; 302 to `/?auth_error=invalid_token` on a malformed token. No side effect, so a mail scanner burns nothing |
| POST | `/password/verify` | form or JSON `token` | form body: 302 to `appURL` with the cookie, or 302 to `/?auth_error=<code>`; JSON body: `{ verified: true }`, with the cookie when the address was unverified, or the error as JSON. `invalid_token` when the password row is gone; `token_expired` |
| POST | `/password/verify/resend` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. A mail goes only to an unverified user with a password, and the earlier link of the address stops working |
| POST | `/password/reset/request` | `{ email, next? }` | `{ sent: true }` always; 429 `rate_limited`; 400 `invalid_body` |
| GET | `/password/reset` | `?token=` | 200 HTML form (`password.resetPage` replaces it); 302 to `/?auth_error=invalid_token` on a malformed token. No side effect |
| POST | `/password/reset` | form or JSON `token`, `password` | form body: 302 to `next` with the cookie, or back to the form on `password_policy` or `password_breached`, or 302 to `/?auth_error=<code>`; JSON body: `{ token, user, session }` with the cookie, or the error as JSON. `invalid_token`, `token_expired`, 429 `rate_limited` |
| POST | `/password/change` | session, `{ currentPassword?, newPassword }` | `{ ok: true }`; 400 `invalid_body`, `password_policy`, `password_breached`; 401 without a session; 401 `invalid_credentials` for a missing or wrong current password; 403 `email_unverified`; 409 `conflict`; 429 `rate_limited` |
| POST | `/otp/request` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. Mails a sign-in code |
| POST | `/otp/verify` | `{ email, code }` | `{ token, user, session }` with the cookie; 400 `invalid_body`, `invalid_code` (a wrong, expired, spent, or unknown code), `too_many_attempts` (the code took `maxAttempts` wrong guesses: request a new one); 429 `rate_limited` |
| POST | `/otp/reset/request` | `{ email }` | `{ sent: true }` always; 400 `invalid_body`; 429 `rate_limited`. Mails a reset code. Only with a `password` config |
| POST | `/otp/reset` | `{ email, code, password }` | `{ token, user, session }` with the cookie; 400 `invalid_body`, `invalid_code`, `too_many_attempts`, `password_policy` and `password_breached` (both spend the code); 429 `rate_limited`. Only with a `password` config |
| GET | `/handoff/start` | `?challenge=&redirect=` | 200 the sign-in page, or 302 to the confirm page when the browser already has a session; 400 `invalid_body`; 429 `rate_limited`. Only with a `handoff` config |
| GET | `/handoff/continue` | `?h=` | 200 the confirm page with a session, the sign-in page without one; 302 to `/?auth_error=<code>` for a spent or unknown id |
| POST | `/handoff/continue` | form `h`, Origin = baseURL | 302 to `<redirect>?code=`; 403 from any other origin; the sign-in page without a session |
| POST | `/handoff/redeem` | `{ code, verifier }` | `{ token, user, session }` as a bearer answer, no cookie; 400 `invalid_body`, `invalid_token`, `token_expired`; 429 `rate_limited` |
| POST | `/tokens` | session, `{ name, expiresInDays?, organizationId? }` | `{ token, apiToken }`, the clear token once; 400 `invalid_body`; 401 without a session (a `tk_` bearer too); 403 `email_unverified`; 404 `not_found` for an organization the user is not a member of; 409 `token_limit` at 50 tokens; 429 `rate_limited` |
| GET | `/tokens` | session | `{ tokens: [{ id, name, hint, expiresAt, lastUsedAt, organizationId, createdAt }] }`, newest first, never a token or its hash; 401; 403 `email_unverified` |
| POST | `/tokens/revoke` | session, `{ id }` | `{ ok: true }`; 400 `invalid_body`; 401; 403 `email_unverified`; 404 `not_found` for another user's token |
| GET | `/tokens/current` | `Authorization: Bearer tk_…` only | `{ user, apiToken }`; 401 for a session cookie, a `ts_` bearer, or no credential |

Without a `passkey` config none of these routes exist, and the router answers 404.

Without a `password` config none of the password routes exist, and the router answers 404. The token routes exist in every deployment.

With `emailOtp: false` none of the code routes exist, and the router answers 404. Without a `password` config the two reset code routes do not exist.

The organization routes follow.

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| POST | `/organizations/create` | session, `{ slug, name, metadata? }` | `{ organization, member }`; 400 `invalid_body`, `slug_reserved`; 401; 403 `email_unverified`; 409 `slug_taken` |
| GET | `/organizations` | session | `{ organizations: [{ organization, role }] }`; 401 |
| POST | `/organizations/update` | session, `{ organizationId, name?, slug?, metadata? }` | `{ organization }`; 400 `invalid_body`, `slug_reserved`; 401; 403 `forbidden_rank`, `email_unverified`; 404; 409 `slug_taken` |
| POST | `/organizations/delete` | session, `{ organizationId }` | `{ ok: true }`; 400 `slug_reserved`; 401; 403 `forbidden_rank`, `email_unverified`; 404 |
| GET | `/organizations/members` | session, `?organizationId=` | `{ members }`; 400 `invalid_body`; 401; 403 `forbidden_rank`; 404 |
| POST | `/organizations/members/add` | session, `{ organizationId, userId, role }` | `{ member }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404; 409 `already_member` |
| POST | `/organizations/members/role` | session, `{ organizationId, userId, role }` | `{ member }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 `not_found`; 409 `last_owner`, `conflict` |
| POST | `/organizations/members/remove` | session, `{ organizationId, userId }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 `not_found`; 409 `last_owner`, `conflict` |
| POST | `/organizations/invite` | session, `{ organizationId, email, role }` | `{ invitation }` with no token; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 `not_found`; 429 `rate_limited` |
| GET | `/organizations/invitations` | session, `?organizationId=` | `{ invitations }`; 400; 401; 403 `forbidden_rank`; 404 `not_found` |
| POST | `/organizations/invitations/revoke` | session, `{ organizationId, invitationId }` | `{ ok: true }`; 400; 401; 403 `forbidden_rank`, `email_unverified`; 404 |
| POST | `/organizations/invitations/accept` | session, `{ token }` | `{ organization, member }`; 400 `invalid_token`, `token_expired`; 401; 403 `email_mismatch`, `email_unverified`; 409 `already_member`; 429 `rate_limited` |
| POST | `/organizations/invitations/decline` | `{ token }`, no session | `{ ok: true }`; 400 `invalid_token`, `token_expired` |
| POST | `/organizations/active` | session, `{ organizationId }` (a string or `null`) | `{ user, session }` with `session.activeOrganizationId`; 401; 403 `forbidden_rank` |

Without an `organizations` config none of the organization routes exist, and the router answers 404.

With hooks (see "Hooks" below), every organization write and every sign-in
can also answer 403 `hook_refused` (with `message`) and 500 `hook_failed`.
With `organizations.limits`, create answers 409 `organization_limit`, add
and accept answer 409 `member_limit`, and invite answers 409
`invitation_limit`. A sign-in whose session hook names an organization the
user is not a member of answers 404 `not_found`.

Set `appName` in the config to name the app. It is 1 to 80 characters with
no control character. The default is the host of `baseURL`. The default
pages show it in the title and the heading. The magic link mail subject is
`Sign in to <appName>`. The invitation mail subject is
`You are invited to <organization name> on <appName>`. Each page function
receives `appName` in its input.

The confirm page is `defaultConfirmPage`. Replace it with
`magicLink.confirmPage` in the config. The function returns the markup
only; core sets `cache-control`, `referrer-policy`, `x-robots-tag`, and a
content security policy that permits inline style, no script, and a form
post to this origin only. A page that needs script or a remote stylesheet
needs its own route in the app, because the policy header is fixed.

## Apps on another origin

Set `appURL` to the app's origin and list it in `trustedOrigins`. Every
redirect after a sign-in then lands on `appURL` plus `next`, and errors
go to `appURL/?auth_error=<code>`. A `next` under `basePath` stays on
`baseURL`; that is how the handoff rides through a sign-in.

A trusted origin gets credentialed CORS: the router answers its
preflight with 204 and marks every response with
`Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`.
The browser still needs the session cookie on the request. With the
default `SameSite=Lax` the cookie goes on every same-site request, so an
app on a sibling subdomain of the API works as is. An app on another
site needs `cookie: { sameSite: "None" }`; then any site can make the
browser send the cookie, and the Origin rule on POST is what refuses
them. The cookie names stay `tempo_session` and `tempo_session_oauth` in
version 1; a `__Host-` prefix is a version 2 item.

## Handoff for native and desktop apps

Set `handoff: { schemes: ["consumera://"] }`. The app makes a PKCE
verifier and its S256 challenge, then opens the system browser at
`GET /auth/handoff/start?challenge=<c>&redirect=consumera://auth`. Core
shows the sign-in page: a magic link form, the configured social
buttons, a passkey button, and, with a `password` config, an email and
password form with a Forgot password button.
With a `password` config the form also has a Create account button. It
posts the email and the password to `POST /auth/password/sign-up`; that
answer sets the session cookie, and the page goes on to the continue
path. Every method ends by visiting
`/auth/handoff/continue?h=<id>` on the API origin, which shows a confirm
page. When the person presses the button, core mints a one-time code and
redirects to `consumera://auth?code=<code>`. The app
then calls `POST /auth/handoff/redeem { code, verifier }` and keeps the
bearer token. A code lives two minutes and redeems once; a start lives
ten minutes, or as long as a magic link if that is longer.

The continue is a consent step. A signed-in browser sees a page that names the account and the app, and the code is minted only when the person presses the button. The post is accepted from the API origin only.

In development `devRedirectPattern` admits a full redirect URL, for
example `/^exp:\/\/[\d.]+:\d+\/--\/auth$/` for Expo Go. Core refuses a
pattern with the `g` or `y` flag, and refuses any admitted `http` or
`https` URL that is not on a loopback host.

The handoff confirm page adds the source of the matched dev redirect to
`form-action`: its scheme (`exp:`), or the origin of a loopback URL
(`http://127.0.0.1:8081`). A dev redirect on `[::1]` cannot be listed.
Use `127.0.0.1`.

`signInPage` replaces the page. The function gets the base path, the continue
path, the enabled methods, and the script nonce. It must put the nonce on its
script tag. The `methods` input has the flags `magicLink`, `google`, `apple`,
`passkey`, and `password`, and `providers`, a list of `{ name, label }` for
every configured provider other than Google and Apple. `password` is true when
the config has a `password` section. A custom `signInPage` must render
`methods.providers`, or the buttons for GitHub, LinkedIn, and the list
providers do not show. `@tempo-auth/handoff` (plan 5b) does the app side.

## Social sign-in

Configure `social.google` with `{ clientId, clientSecret }` and
`social.apple` with `{ clientId, teamId, keyId, privateKey }`. The Apple
`clientId` is the Services ID, and `privateKey` is the PKCS#8 PEM from the
developer portal. Core signs a five-minute Apple client secret on every
token exchange, so nothing stored expires. Rotate the key in the portal
and change `privateKey`.

Register `<baseURL><basePath>/social/<provider>/callback` as the redirect
URI at the provider. The flow sends `state`, a PKCE S256 challenge, and, for
an OpenID Connect provider, `nonce`. Apple's support for PKCE is unverified;
the state, the nonce, and the binding cookie bind the exchange without it.
Core sends the client secret in the token request body (`client_secret_post`).
A provider that expects `client_secret_basic` answers `invalid_client`.

Linking: a social identity links to an existing user only when the
provider reports the email as verified and it equals the user's email.
Otherwise core creates a new user, or answers `email_taken_unverified`
when the address is in use. A profile with no email answers
`email_required`.

An account created through an unverified email is a claim. When a sign-in
proves the address (a magic link, or a provider that reports the email
verified), core deletes that user's other identities and every session,
then marks the email verified. The claimant loses access; the owner keeps
the account.

GitHub and LinkedIn are presets: `social.github` and `social.linkedin` each
take `{ clientId, clientSecret }`. GitHub issues no ID token, so core reads
`GET https://api.github.com/user` and `GET https://api.github.com/user/emails`
with the access token, under the scope `read:user user:email`. The subject is
the numeric GitHub id. The address counts as verified only when the primary
address has `verified: true`. A person whose primary address is unverified
gets a new unverified account, or `email_taken_unverified` when the address
has an account. Core never links it. LinkedIn: core reads
`GET https://api.linkedin.com/v2/userinfo` with the access token, under the
scope `openid profile email`, as Better Auth does. The subject is LinkedIn's
`sub`. Core ignores LinkedIn's ID token. Add the product "Sign In with
LinkedIn using OpenID Connect" to the LinkedIn app.

Any other provider is a list entry. `social.oidc` takes OpenID Connect
providers, and `social.oauth2` takes providers that issue no ID token. A
`name` matches `^[a-z][a-z0-9-]{0,31}$`, is unique across both lists, and is
not `google`, `apple`, `github`, `linkedin`, `email`, or `credential`. The
`label` is the button text on the sign-in page. An `oidc` entry reads
`<issuer>/.well-known/openid-configuration` on its first start and keeps the
endpoints for the life of the `createAuth` instance. The document's `issuer`
must equal `issuer` exactly. Set `endpoints` and core never reads the
document, so a sign-in does not depend on the provider's discovery at
request time.

```ts
social: {
  github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
  oidc: [
    {
      name: "microsoft",
      label: "Continue with Microsoft",
      issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
      clientId: env.ENTRA_CLIENT_ID,
      clientSecret: env.ENTRA_CLIENT_SECRET,
    },
  ],
  oauth2: [
    {
      name: "discord",
      label: "Continue with Discord",
      authorizeUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      scope: "identify email",
      async userinfo(accessToken, fetch) {
        const res = await fetch("https://discord.com/api/users/@me", {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error(`discord answered ${res.status}`);
        const u = (await res.json()) as {
          id: string;
          email?: string | null;
          verified?: boolean;
          global_name?: string | null;
        };
        return {
          subject: u.id,
          email: u.email ?? null,
          emailVerified: u.verified === true,
          name: u.global_name ?? null,
          image: null,
        };
      },
    },
  ],
},
```

The Microsoft and Discord entries are examples. Core does not test them.
Check each endpoint and claim in the provider's documentation on the day you
configure it. Microsoft Entra ID sends no `email_verified` claim by default,
so an Entra sign-in never links to an existing account by its address.

`userinfo` gets the access token and a fetch. Call the provider with that
fetch: core puts a 10 s limit on it, and the whole step stops at 10 s.
Answer `emailVerified: true` only when the provider says that this person
proved the address. Core counts no other value as verified. Core never
stores or logs the access token, and a failure logs the error name, never
its message.

`social.fetch` and `jwt` exist for tests: inject a fetch for the token
endpoint and a fake verifier, so no test reaches a provider.

## Passkeys

Set `passkey: { rpID, rpName, origins }`. `rpID` is the registrable
domain the credentials bind to, and every origin in `origins` must be on
it (the host equals it or ends with `.<rpID>`). Registration needs a
session and a verified email. Sign-in uses a discoverable credential, so
the options carry no credential list, and both ceremonies require user
verification. Every origin in `origins` must also be `baseURL` or in `trustedOrigins`, or the router refuses its posts; `resolveConfig` checks this.

The browser side is `navigator.credentials.create(options)` and
`navigator.credentials.get(options)` with the options JSON from the
routes (through `PublicKeyCredential.parseCreationOptionsFromJSON` and
`parseRequestOptionsFromJSON`), and the credential's `toJSON()` goes back
as `response`. Plan 5's client package wraps this.

`@tempo-auth/core/testing` exports `SoftAuthenticator`, a software
authenticator on Web Crypto that produces both responses, so an app's
tests prove the whole flow without a browser.

`webauthn` in the config replaces the seam. The default is
@simplewebauthn/server 14.0.3, which runs on Workers without
`nodejs_compat` (proved by the example Worker's spike test).

## Passwords

Set `password: {}` to turn on password sign-in. The fields are all
optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `hash` | `createPbkdf2PasswordHash()` | The hash seam. It has `hash`, `verify`, and `dummy`. |
| `minLength` | 8 | The lower bound, 8 to 128. Counted in code points. |
| `breachCheck` | none | `(plain) => Promise<boolean>`. True refuses the password with `password_breached`. |
| `resetTtlMinutes` | 15 | The life of a reset link, 1 to 1440. |
| `resetPage` | `defaultResetPage` | The HTML of the reset page. |

The default hash is PBKDF2-HMAC-SHA256 on Web Crypto. A hash is stored as
`pbkdf2-sha256$<iterations>$<salt>$<hash>`. The salt is 16 random bytes and
the output is 32 bytes, both in base64url. The default cost is 100000
iterations, because Workers refuses a higher count. `maxIterations`
(default 100000) is the highest cost the seam hashes or verifies. A stored
hash above it answers `{ ok: false, rehash: false }` and never runs. A
hash with a lower cost verifies, then the engine rehashes it at the next
sign-in.

The default cost needs more CPU than Workers Free allows (10 ms per
request). A deployment needs Workers Paid.

A password is hashed as given, with no Unicode normalization. A person who
types the same text in another normal form does not sign in.

A sign-in for an unknown address, or for a user with no password, verifies
against a dummy hash. The seam builds the dummy on first use and keeps it,
so the time is the same. A hash error never reaches the caller: the answer
is `invalid_credentials`.

A magic link or a provider proof of an unverified address deletes that
user's password, as it deletes the other credentials of a claimant. The
verify link keeps the password it confirms.

A reset of a verified user ends every session and keeps the passkeys and
social identities. A reset of an unverified user claims the address. A
reset writes the new password before it deletes the sessions. A reset of
a verified user also deletes the user's pending handoff codes. Every reset
deletes the address's other pending reset links. A password change writes
the new password first, deletes every other session, and deletes the
user's pending handoff codes. It keeps the current session. A change also
deletes the address's pending reset links (added 2026-10-10 by the plan 8
final fix wave).

The limits, in the same limiter as the other routes:

| Key | Limit |
| --- | --- |
| `password-sign-up:ip:<ip>` | 10 per hour |
| `password:ip:<ip>` | 20 per 15 minutes |
| `password:email:<email>` | 10 per 15 minutes |
| `password-reset:ip:<ip>` | 20 per 15 minutes |
| `password-reset:email:<email>` | 5 per 15 minutes |
| `password-reset-post:ip:<ip>` | 20 per 15 minutes |
| `password-resend:ip:<ip>` | 20 per 15 minutes |
| `password-resend:email:<email>` | 3 per 15 minutes |
| `password-change:user:<userId>` | 10 per 15 minutes |

The `password:email` limit is a trade-off: 10 wrong tries from anyone stop
password sign-in for that address for 15 minutes. The magic link still
works for the owner. Without the limit, a guess run on one account from
many IP addresses has no bound. Recorded 2026-10-10 by the plan 8 final
fix wave.

The reset POST checks its limit, then reads the link row, then the policy,
then the breach check, then hashes. A transaction consumes the link first.
A spent or expired link costs no breach call and no hash.

## Email codes

Since plan 9e core signs a person in by a code from the mail, and resets a
password by a code. A code is for a device whose mailbox is elsewhere, such
as a phone app, a desktop app, or a CLI, or whose mail client strips links.
It follows the magic link's rules: the request tells nothing about the
account, a right code proves the address, and the claim rule applies. The
sign-in page does not change: a browser has the magic link.

Email codes are on by default. `emailOtp: false` turns them off.

| Field | Default | Meaning |
| --- | --- | --- |
| `ttlMinutes` | 10 | The life of a code, 1 to 60. |
| `length` | 6 | The digits of a code, 6 or 8. |
| `maxAttempts` | 5 | The wrong guesses that spend a code, 3 to 10. |
| `mail` | `defaultEmailOtpMail` | `({ email, code, ttlMinutes, appName }) => MailMessage` for the sign-in code. |
| `resetMail` | `defaultResetOtpMail` | The same, for the reset code. |

Core sends each code mail to the address the code belongs to, whatever
`to` the builder answers.

- One code per address and purpose is live. A new request spends the
  earlier code, so the code of an older mail answers `invalid_code`.
- A wrong code counts one guess. The guess that reaches `maxAttempts`
  spends the code and every other live code of the address and purpose,
  and answers `too_many_attempts`. Every later try answers the same until a
  new request, also when two parallel requests left two live codes. A right
  code after the cap does not sign in.
- A wrong code, an expired code, a spent code, and an address with no code
  answer `invalid_code`. Core does not tell them apart.
- The stored value is HMAC-SHA256 under `secret` of the row id and the
  code. A copy of the verification table gives no code without the secret.
  After a change of `secret`, every live code answers `invalid_code`.
- The guess count is a compare-and-set on the row's `updatedAt`, so
  parallel guesses all count, on D1 and on Postgres. The storage
  conformance suite pins `eq` on a date to the millisecond on every
  adapter. The count stops after `maxAttempts + 1` rounds and answers
  `invalid_code`, with the log line `tempo-auth: email code count gave up`
  and the row id, so a storage that never matches cannot hold a request.
- One address gets at most 20 codes per 24 hours, for both purposes
  together (`otp:email-day:<address>`), after the 15-minute limits. So one
  address takes at most 100 guesses a day with the defaults.
- A reset by code runs the reset link's path: the policy, the breach
  check, the new password, the end of every session, the claim rule, and a
  new session. A password that the policy or the breach check refuses
  spends the code: request a new one. A reset of either kind spends the
  live reset links and codes of the address, and so does a password change.

The odds that an attacker who never sees the mail guesses a code, with the
defaults and a limiter that the product owns (D1 or Postgres):

| Scope | Guesses at most | Odds of a takeover |
| --- | --- | --- |
| One code | 5 | 5 × 10⁻⁶ |
| One address, one day | 100 (20 codes × 5) | 1 × 10⁻⁴ |
| One address, one year | about 36,500 | about 3.6 % |

The attack is loud: at full rate the address gets 20 code mails a day.
`length: 8` divides each figure by 100, so use it for high-value accounts.
The memory limiter is per isolate: on Workers the request and verify
budgets, the daily cap too, multiply by the isolate count. The per-code cap
stays global, because it lives in the row.

```ts
import { createClient } from "@tempo-auth/client";

const client = createClient({ baseURL: "https://api.example.com" });
await client.emailOtp.request({ email });
const signedIn = await client.emailOtp.verify({ email, code }); // { token, user, session }
```

## API tokens

A script or a CLI signs in with an API token, not with a password. A
person with a session creates the token. The clear token appears once, in
the create answer, and core stores its SHA-256 only.

```ts
// A route that a script may call: a session or a token.
const c = await auth.caller(request);
if (!c) return Response.json({ error: "unauthorized" }, { status: 401 });
// c.kind === "session": c.user, c.session, c.refreshed
// c.kind === "token":   c.user, c.apiToken, c.activeOrganizationId
const res = Response.json({ id: c.user.id });
// After a sliding refresh, renew the cookie or the browser drops it early.
const renewed = c.kind === "session" ? auth.sessionCookie(request, c) : null;
if (renewed) res.headers.set("set-cookie", renewed);
return res;
```

- `auth.session(request)` resolves sessions only. Every route that calls
  it, core's and the app's, answers 401 to a `tk_` bearer. Core's own
  routes call it, except `GET /tokens/current`. So a token cannot create a
  token, change a password, or touch passkeys or organizations.
- A token is `tk_` plus 43 base64url characters. `hint` holds the 8
  characters after `tk_`, so a list tells the tokens apart.
- `name` is 1 to 80 characters with no control character. `expiresInDays`
  is an integer from 1 to 3650, default 90. `null` means no expiry.
- `organizationId` may be omitted or `null`, for no organization. Else it
  names one organization the user is a member of. Core
  checks the membership at create and at each use. When the membership is
  gone, `caller` answers null, and the token stays in the list.
- A user holds at most 50 tokens (`token_limit`). Create is limited to 20
  per user per hour. An expired token goes at its next use and at the
  sweep, and it does not count against the cap.
- `lastUsedAt` is written at most once per hour.
- A `tk_` value counts only in the `Authorization` header, never in a
  cookie. A CLI passes `token: () => "tk_…"` to `createClient`.
- A password reset, a password change, and a sign-out delete no token. Revoke
  a token from the list.
- In process: `auth.api.tokens.create`, `list`, `revoke`, and `current`.

## Organizations

Set `organizations: {}` to turn the feature on. Without it, the organization
routes and the `api` functions answer 404 `not_found`.

**Ranks.** A role name maps to a rank. The default table is `viewer` 1,
`member` 2, `admin` 3, `owner` 4. A member may hold more than one role,
joined by a comma, such as `member,billing`. The rank of that member is the
highest rank among the parts. A part that is not in the table ranks 0, so
an unknown role never grants a right. Pass `ranks` to change the table. It
must name `owner`.

**Slugs.** A slug is lower case, up to 64 characters, with digits and
hyphens. Core folds the slug to NFKC first, so a look-alike letter cannot
hide a reserved word. The default reserved slugs are `admin`, `api`,
`auth`, `internal`, `operator`, `ops`, `platform`, `system`, and `www`.
Pass `reservedSlugs` to replace the list. A reserved slug answers
`slug_reserved`. A slug in use answers `slug_taken`.

**Platform role.** Set `platformOrganization` and `platformRole` to keep one
role for staff. Core accepts that role in the platform organization only.
Any other organization refuses it with `invalid_body`.

The platform slug is reserved, so `createOrganization` refuses it. Seed the
platform organization yourself, through the storage adapter or a
migration. Write one `organization` row with that slug and one `member`
row for the first staff user. The member role must include `owner`, and
also the platform role if it is not `owner`, for example `owner,operator`.
Take the fields of each row from `schema` (`organization`: `id`, `slug`,
`name`, `metadata`, `createdAt`, `updatedAt`; `member`: `id`,
`organizationId`, `userId`, `role`, `createdAt`, `updatedAt`). After the
seed, the engine refuses a slug change and a delete of the platform
organization with `slug_reserved`, because no route could create it again.
A change of its name or metadata is allowed. Accept also checks the
platform role again: if the organization of a pending invitation no longer
has the platform slug, the link is dead and the answer is `invalid_token`.

**Write rules.**

- A creator becomes `owner` of the new organization. The creator needs a verified email.
- An `admin` may update the organization, add members, change roles, remove other members, and manage invitations.
- Only an `owner` may change the slug or delete the organization.
- A caller may grant or set only a role with a rank at or below the caller's own rank. This is the no-escalation rule.
- A caller may not change or remove a member of higher rank.
- A member may always remove themselves, unless that member is the last owner.
- The last owner cannot leave, be demoted, or be removed. The answer is `last_owner`.
- Two owner writes at the same time cannot both succeed. The second answers `conflict`. This means a concurrent owner write. Retry.
- A role change or a removal writes only if the member still holds the role that the caller read. If another request changed that role first, the answer is `conflict`. Read the member again and retry.

**Invitations.** An invitation is valid for seven days. Set
`invitationTtlDays` to change this. An organization holds one pending
invitation for each address. A new invitation replaces the old one, and the
old link stops working. The token is in the mail only. No route answer
carries it. To accept, the caller must hold a verified email that equals the
invited address, or the answer is `email_mismatch`. Accept checks the
inviter again. If the inviter left or lost rank since the invite, the link
is dead and the answer is `invalid_token`. The same is true when the
invited role now ranks 0, because the app removed it from `ranks`. Decline
needs no session, because the link is the credential. Set
`invitationLinkBuilder` to change the link in the mail. The default is
`<appURL>/?invitation=<token>`.

Accept is limited to 20 per IP per 15 minutes. Invite is limited to 20 per
inviting user per 15 minutes, and to 5 per invited address per hour. A
refusal answers 429 `rate_limited` and sends no mail.

If the invited person is already a member, accept keeps the current role
when it ranks at or above the invited role. A higher invitation replaces
the role. It does not add to it: a `member,billing` member who accepts an
`admin` invitation becomes `admin`, and `billing` is gone.

The invitations list shows each pending invitation that has not expired. It
does not check the inviter. An invitation whose inviter left or lost rank
stays in the list until someone tries to accept it. That accept then
deletes it, and no record of it stays.

**Active organization.** A session may name one active organization.
`POST /organizations/active` sets it, and `null` clears it. The caller must
be a member. The value comes back in `session.activeOrganizationId`.
Core stores the value and does not read it for any other check.

The value is a choice, not a right. Core clears it when the member leaves,
is removed, or the organization is deleted. A demotion does not clear it.
Check the member's rank on each request.

**Error codes.** Organization routes add these codes to the existing set.

| Code | Status | Meaning |
| --- | --- | --- |
| `forbidden_rank` | 403 | The caller is not a member, or the rank is too low |
| `slug_reserved` | 400 | The slug is on the reserved list, or the organization is the platform organization |
| `slug_taken` | 409 | Another organization uses the slug |
| `last_owner` | 409 | The write would leave no owner |
| `already_member` | 409 | The user is already a member |
| `email_mismatch` | 403 | The invitation is for another address |
| `conflict` | 409 | A concurrent write changed the organization or the member; retry |
| `organization_limit` | 409 | The user holds `organizations.limits.perUser` member rows |
| `member_limit` | 409 | The organization holds `organizations.limits.membersPerOrganization` members |
| `invitation_limit` | 409 | The organization holds `organizations.limits.pendingInvitationsPerOrganization` pending invitations |
| `hook_refused` | 403 | A before hook threw `hookRefusal(message)`; the body carries `message` |
| `hook_failed` | 500 | A before hook threw another error, or a session patch was wrong |

## Hooks

A hook is your code at a named point of a core flow (plan 9d). Pass plain
objects of functions in `hooks`:

```ts
import { createAuth, hookRefusal } from "@tempo-auth/core";

const auth = createAuth({
  // ...
  organizations: { limits: { perUser: 5, membersPerOrganization: 50 } },
  hooks: {
    organization: {
      async beforeCreate({ organization, user }) {
        if (organization.slug.startsWith("acme-")) throw hookRefusal("Choose another name.");
        // Write your own row first, with the id core minted. On Postgres, on a
        // connection that core's adapter does not hold (see the rule below).
        await tenants.create({ id: organization.id, ownerId: user.id });
      },
      async afterAddMember({ organization, member, via }) {
        await audit.write("member.added", organization.id, member.userId, via);
      },
    },
    session: {
      beforeCreate: () => ({ ip: null, userAgent: null }),
      async afterEnd({ session, reason }) {
        await audit.write("session.ended", session.id, reason);
      },
    },
  },
});
```

- A before hook runs inside the flow's transaction, after core's rank
  checks and limits, and before the first write. This holds for
  `session.beforeCreate` in every sign-in too (see "Session points").
  `throw hookRefusal(message)` answers 403 `{ "error": "hook_refused", "message": "…" }`. A message that
  is empty, longer than 200 characters, or holds a control character becomes
  "The app refused this request.". Any other throw answers 500
  `hook_failed` and logs `tempo-auth: before hook failed <hook> <error name>`.
  The error name is logged only when it is a plain class name such as
  `TypeError`; any other name logs as `Error`, because the app sets it.
  Either way, no row is written.
- Three flows have a write before the before hook. An owner demotion and
  an owner removal stamp the owner lock first, and a passkey sign-in moves
  the passkey counter first. A refusal undoes the stamp. On Postgres the
  stamp's row lock is held while the hook runs, so a slow hook on an owner
  write blocks the other owner writes of that organization.
- An after hook runs after the commit, before the answer. A throw cannot
  undo the row: core logs `tempo-auth: after hook failed <hook> <row id>
  <error name>` and answers success. If your app must not keep a core row
  without its own row, write yours in the before hook, with the id core
  minted. Then the residual of a failure is your row with no core row. On
  Postgres, write it on a second connection (see the rule on one
  connection below).
- Each hook gets a copy of its event. A before hook cannot change the row,
  except `session.beforeCreate`, which may answer `{ ip?, userAgent?,
  activeOrganizationId? }`, each a string or null. The organization must be
  one the user is a member of, or the sign-in answers 404 `not_found`. Any
  other field answers 500 `hook_failed`.
- Organization points: `beforeCreate`, `afterCreate`, `beforeUpdate`,
  `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeAddMember` and
  `afterAddMember` (`via`: `create` for the creator's owner row, `add`, or
  `invitation`), `beforeUpdateMemberRole`, `afterUpdateMemberRole`,
  `beforeRemoveMember` and `afterRemoveMember` (`via`: `remove` or `leave`),
  `beforeInvite`, `afterInvite`, `afterAcceptInvitation`,
  `afterDeclineInvitation` (`user` is null when the decline carried no
  session), and `afterRevokeInvitation`. An accept runs `beforeAddMember`
  with `via: "invitation"` every time, and `afterAddMember` only when it
  made a new member row. An accept that raises an existing member's role
  runs `beforeUpdateMemberRole` and `afterUpdateMemberRole` too, with the
  inviter as `by` (the accepting user when the inviter's user row is
  gone). A refusal keeps the role and the invitation pending. A delete
  runs no member hook for the rows it removes.
- Session points: `beforeCreate` and `afterCreate` (`via`: `password`,
  `magic_link`, `social`, `passkey`, `handoff`, or `email_otp`; a reset by
  code is `password`), and `afterEnd`
  (`reason`: `sign_out`, `password_reset`, `password_change`, `claim`, or
  `expired`), once per ended row. `sweepExpired` deletes expired rows in
  bulk and fires no hook, so `expired` fires only when a request presents
  the token after its expiry. A claim ends a claimant's sessions with
  `claim` in every flow that proves the address: the magic link, the
  social sign-in, the verify link, and the reset of an unverified user. A
  reset of a verified user ends that user's sessions with `password_reset`.
- `session.beforeCreate` runs on a password sign-in only after the password
  is correct. So `hook_refused` against `invalid_credentials` tells the
  caller that the password was right. A ban hook should refuse with a text
  that does not depend on the password. The code still differs from a
  wrong password, so only the sign-in rate limits bound such a guess, as
  in Better Auth's ban check.
- `session.beforeCreate` runs before the first write of the sign-in's
  transaction in every flow except the reset (see its row). On D1 the undo
  of a write is not exact, so a refusal after a write could bring back a
  claimant's rows. The hook sees the user as the flow will leave it:

  | Flow | The `user` the hook sees |
  | --- | --- |
  | Password sign-up | A user core minted and has not written yet. The row does not exist at hook time, so an app's own write in the hook cannot rely on a foreign key to core's user row |
  | Password sign-in, passkey, handoff | The stored user |
  | Magic link | The stored user, marked verified when the link claims it, or a minted user that does not exist yet |
  | Social sign-in | The stored user, marked verified when the sign-in claims it and with the name and image filled, or a minted user that does not exist yet |
  | Verify link | The stored user, marked verified. A user already verified gets no session and no hook |
  | Reset | The stored user, marked verified when the reset claims it, or a minted user that does not exist yet. The reset consumes its link first, and the hook runs before every other write. The consume belongs to this request alone, so its undo is exact |

  For a minted user, a set `activeOrganizationId` answers `not_found`: the
  user is a member of nothing yet.

- A refused sign-in has spent what it presented, when the flow spends it
  before its transaction. A refused magic link, verify link, or social
  callback is consumed, and a refused passkey sign-in has spent its
  challenge and moved the passkey counter. The person starts again. A
  refused reset keeps its link: its consume is in the transaction, and the
  refusal undoes it.
- A before hook can run for a sign-in that then fails, and `afterCreate`
  does not run. A claim race guard deletes the new session in the same
  transaction and answers an error. A verify link whose password row is
  gone answers `invalid_token` after the hook. A flow that retries after a unique key race
  (the magic link, the social sign-in, the sign-up, the reset) runs its
  before hook again. The organization flows have the same window: a role
  change or a remove whose member changed since the read answers
  `conflict` after its before hook, and an accept that loses the consume
  race answers `invalid_token` after `beforeAddMember`, and for a raise
  also after `beforeUpdateMemberRole`. No after hook runs
  for any of these.
- Hooks have no timeout, as the mail port has none. A hook that never
  settles holds the request. A before hook holds the transaction, and on
  Postgres one connection, for as long as it runs. Do not open a
  transaction on core's storage from a before hook.
- On Postgres, a before hook must not run a query on the client that core's
  adapter uses while its pool has one connection (`max: 1`, the setup the
  adapter README gives for Workers). The transaction holds that one
  connection and waits for the hook, and the query waits for the
  connection: with one connection the request hangs until the pool times
  out. To write your own row from a before hook, use a second connection (a
  pool of two or more, or a separate client). Or write it from the after
  hook and accept the orphan rule above. On D1, a write through the
  binding is a separate request and takes no lock. After hooks run after
  the commit and are not affected.
- Core has no request hooks. Wrap `auth.handle`, and read
  `auth.caller(request)` for the caller.
- `createAuth` refuses a hook that is not a function, a name that is no
  hook point, a hook object that is not a plain object, and organization
  hooks while `organizations` is off.

### Limits

`organizations.limits` takes three positive integers. Each is off by default.

| Limit | Counts | Answer at the limit |
| --- | --- | --- |
| `perUser` | the user's member rows at any rank; a leave frees a slot | 409 `organization_limit` on create |
| `membersPerOrganization` | the organization's member rows, on add and on an accept that makes a member | 409 `member_limit`; the invitation stays pending |
| `pendingInvitationsPerOrganization` | the pending, unexpired invitations to other addresses | 409 `invitation_limit` on invite |

Core counts inside the transaction, before the before hook. On D1 the count
and the write are not isolated, so two writes at the same moment can both
pass at the limit minus one. Postgres read committed has the same window.
The API token cap has the same rule.

## Sweep

`auth.api.sweepExpired()` deletes the rows that no flow can use any more.
It removes every verification row past its expiry, consumed or not. It
removes a consumed verification row one day after the consume; this only
matters when `magicLink.ttlMinutes` is above one day. It removes
invitations that are accepted or expired, and sessions past their expiry.
It also calls the limiter's `sweep`, when the limiter has one, to delete
the limit windows that ended. It answers five counts:
`verificationExpired`, `verificationConsumed`, `invitations`, `sessions`,
and `limits`. It is an `api` function and not a route. Call it from a
scheduled handler. It is safe to run at any time. A replayed token
answers `invalid_token` after the sweep because its row is gone.

Since plan 8b it also deletes API tokens past their expiry and answers a sixth count, `apiTokens`. A token with no expiry stays.

```ts
export default {
  fetch: (request: Request) => auth.handle(request),
  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(auth.api.sweepExpired());
  },
};
```

Add a cron trigger to the Worker config, for example `"triggers": { "crons": ["17 * * * *"] }`.
Without a trigger, expired rows stay in the database.

## Limits in version 1

- The default limiter counts in memory. On Workers every isolate has its
  own count, so the real limit is the limit times the isolate count. Pass
  a shared `limiter` for a real limit. The D1 adapter ships `createD1Limiter`
  and the Postgres adapter ships `createPostgresLimiter`, both on `ta_limit`.
  The memory limiter is for tests.
- The memory adapter is for tests and examples. It keeps rows in the
  isolate.
- A request with no client IP counts against one shared IP bucket. A host
  that sets no `cf-connecting-ip` shares one budget across all callers.
- Off Workers, a caller can set `cf-connecting-ip` and rotate it past the
  per-IP limit. Pass a `clientIp` function that reads the header your
  trusted proxy sets.
- The social binding cookie is `SameSite=None`, limited to the social
  path, 10 minutes. Apple posts its callback cross-site, and a Lax cookie
  is not sent on that post.
- Social start is limited to 30 per IP per 15 minutes for every provider,
  in the same per-isolate limiter as the magic link. An `oidc` entry reads
  its discovery document after this limit.
- Every call to a provider (the token exchange, the user info step, the
  discovery read) stops after 10 s and answers `oauth_failed`.
- The confirm page has no script, so a double click on its button sends
  two posts. The first consumes the token and sets the cookie. If the
  browser drops the first answer, the second answers `invalid_token`, and
  the person asks for a new link. A page from `magicLink.confirmPage` may
  disable the button after the first press, but core's content security
  policy permits no script, so such a page needs its own route in the app.
- One binding cookie per browser: a second social start, in another tab
  or for the other provider, replaces it, and the first flow then answers
  `invalid_token`. Start again.
- The binding cookie and the session cookie are plain host cookies. A
  host on a sibling subdomain of the API can set a cookie with the same
  name for the parent domain. Keep the API on its own registrable domain,
  or wait for the `__Host-` decision in plan 5.
- A passkey challenge is valid for five minutes and for one use. Passkey
  sign-in options are limited to 30 per IP, and verifies to 20 per IP,
  per 15 minutes, in the same per-isolate limiter.
- `claimEmail` deletes a user's passkeys when a proof arrives for an
  address that was unverified. Registration already needs a verified
  email, so this only matters for a path that creates passkeys another
  way.
- Replay protection is the challenge: a second use of the same assertion answers `invalid_token`. The counter write is conditional on the counter read, which separates two different assertions; an authenticator that always reports 0 is accepted after 0, as WebAuthn allows.
- Invite is limited to 20 per inviting user per 15 minutes and to 5 per
  invited address per hour, in the same per-isolate limiter. Each invite
  sends a mail from the app's sender, so the product owns this limit. The
  per-address budget is shared by every inviter, so one verified user can
  use up an address's five invites for an hour; the per-user budget bounds
  how many addresses one user can do that to.
- Organization `metadata` is at most 4096 bytes as JSON. A larger value
  answers 400 `invalid_body`. Every member reads it in `GET /organizations`.
- Two invites for the same address at the same time can leave two pending
  invitations, because the pair of organization and address is an index,
  not a unique key. Both links work until one is accepted, revoked, or
  expired.
- On Node, loading @simplewebauthn/server prints one ExperimentalWarning
  about ML-DSA. It is the library's post-quantum probe, not a tempo-auth
  setting, and workerd prints nothing.
- Invitation accept is limited to 20 per IP per 15 minutes, in the same per-isolate limiter.
- Email codes: a request is limited to 3 per address and 20 per IP, and a
  verify or a reset to 10 per address and 30 per IP, per 15 minutes, in the
  same limiter. The sign-in code and the reset code share each budget. Two
  parallel requests for one address can leave two live codes; the verify
  reads the newest.
- Email codes (amended 2026-10-13 by the plan 9e final fix wave): a request
  is also limited to 20 per address per 24 hours, for both purposes, in the
  same limiter. The odds table is in "Email codes".
- Core at version 4 needs the `0004_schema_v4` migration in both adapters. Version 4 adds the password table.
- Core at version 5 needs the `0005_schema_v5` migration in both adapters. Version 5 adds the API token table, `ta_api_token`.
- Handoff start is limited to 30 per IP, and redeem to 20 per IP, per 15
  minutes, in the same per-isolate limiter.
- The sign-in page needs a browser that keeps cookies between the start
  and the callback of a social sign-in; an ephemeral auth session that
  drops cookies answers `invalid_token` on the callback.
- `devRedirectPattern` admits any URL it matches. A loose pattern lets a
  page that can open the system browser send the one-time code to an
  origin it controls. Keep the pattern to the dev host and port, and
  leave it unset in production.
- The router adds the CORS headers to a handler's response in place. A
  handler that returns a `Response` with immutable headers, such as
  `Response.redirect` or a proxied fetch answer, must copy it first. Every
  route core ships builds its own `Response`.

## The storage port

Six methods: `create`, `findOne`, `findMany`, `update`, `delete`,
`transaction`. Clauses join with AND. Operators: `eq ne in lt lte gt gte`.
One sort field. No joins. Run `runAdapterConformance` from
`@tempo-auth/core/conformance` against a new adapter; it is the contract.
