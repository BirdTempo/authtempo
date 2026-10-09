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
| POST | `/magic-link/verify` | form or JSON `token` | 302 to `next` with the session cookie; 302 to `/?auth_error=<code>` on failure |
| GET | `/social/google/start`, `/social/apple/start` | `?next=` | 302 to the provider with a binding cookie; 302 to `/?auth_error=rate_limited` when limited. A route exists only for a configured provider |
| GET | `/social/google/callback` | `?code&state` | 302 to `next` with the session cookie; 302 to `/?auth_error=<code>` on failure |
| POST | `/social/apple/callback` | form `code, state, user?` from Apple | same as the Google callback. The Origin check is skipped here; the state row and the binding cookie bind the post |
| GET | `/session` | cookie or `Authorization: Bearer` | `{ user, session }` or 401 |
| POST | `/sign-out` | cookie or bearer | `{ ok: true }` and clears the cookie |
| POST | `/passkey/register/options` | session | the creation options JSON for `navigator.credentials.create`; 401; 403 `email_unverified` |
| POST | `/passkey/register/verify` | session, `{ response, name? }` | `{ passkey }`; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed`; 401; 403 `email_unverified`. A credential id that is already registered answers `passkey_failed` |
| POST | `/passkey/authenticate/options` | `{}` | the request options JSON for `navigator.credentials.get`; 429 `rate_limited` |
| POST | `/passkey/authenticate/verify` | `{ response }` | `{ user, session }` with the session cookie; 400 `invalid_body`, `invalid_token`, `token_expired`, `passkey_failed` (an unknown credential or a bad signature); 429 `rate_limited` |
| GET | `/passkeys` | session | `{ passkeys: [{ id, credentialId, name, deviceType, backedUp, createdAt }] }`; 401 |
| POST | `/passkeys/delete` | session, `{ id }` | `{ ok: true }`; 400 `invalid_body`; 401; 404 `not_found` |

Without a `passkey` config none of these routes exist, and the router answers 404.

The confirm page is `defaultConfirmPage`. Replace it with
`magicLink.confirmPage` in the config. The function returns the markup
only; core sets `cache-control`, `referrer-policy`, `x-robots-tag`, and a
content security policy that permits inline style, no script, and a form
post to this origin only. A page that needs script or a remote stylesheet
needs its own route in the app, because the policy header is fixed.

## Social sign-in

Configure `social.google` with `{ clientId, clientSecret }` and
`social.apple` with `{ clientId, teamId, keyId, privateKey }`. The Apple
`clientId` is the Services ID, and `privateKey` is the PKCS#8 PEM from the
developer portal. Core signs a five-minute Apple client secret on every
token exchange, so nothing stored expires. Rotate the key in the portal
and change `privateKey`.

Register `<baseURL><basePath>/social/<provider>/callback` as the redirect
URI at the provider. The flow sends `state`, `nonce`, and a PKCE S256
challenge. Apple's support for PKCE is unverified; the state, the nonce,
and the binding cookie bind the exchange without it.

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

## Limits in version 1

- The default limiter counts in memory. On Workers every isolate has its
  own count, so the real limit is the limit times the isolate count. Pass
  a shared `limiter` for a real limit.
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
- Social start is limited to 30 per IP per 15 minutes, in the same
  per-isolate limiter as the magic link.
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
- On Node, loading @simplewebauthn/server prints one ExperimentalWarning
  about ML-DSA. It is the library's post-quantum probe, not a tempo-auth
  setting, and workerd prints nothing.

## The storage port

Six methods: `create`, `findOne`, `findMany`, `update`, `delete`,
`transaction`. Clauses join with AND. Operators: `eq ne in lt lte gt gte`.
One sort field. No joins. Run `runAdapterConformance` from
`@tempo-auth/core/conformance` against a new adapter; it is the contract.
