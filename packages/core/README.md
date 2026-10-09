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
| POST | `/password/reset/request` | `{ email, next? }` | `{ sent: true }` always; 429 `rate_limited`; 400 `invalid_body` |
| GET | `/password/reset` | `?token=` | 200 HTML form (`password.resetPage` replaces it); 302 to `/?auth_error=invalid_token` on a malformed token. No side effect |
| POST | `/password/reset` | form or JSON `token`, `password` | form body: 302 to `next` with the cookie, or back to the form on `password_policy` or `password_breached`, or 302 to `/?auth_error=<code>`; JSON body: `{ token, user, session }` with the cookie, or the error as JSON. `invalid_token`, `token_expired`, 429 `rate_limited` |
| POST | `/password/change` | session, `{ currentPassword?, newPassword }` | `{ ok: true }`; 400 `invalid_body`, `password_policy`, `password_breached`; 401 without a session; 401 `invalid_credentials` for a missing or wrong current password; 403 `email_unverified`; 409 `conflict`; 429 `rate_limited` |
| GET | `/handoff/start` | `?challenge=&redirect=` | 200 the sign-in page, or 302 to the confirm page when the browser already has a session; 400 `invalid_body`; 429 `rate_limited`. Only with a `handoff` config |
| GET | `/handoff/continue` | `?h=` | 200 the confirm page with a session, the sign-in page without one; 302 to `/?auth_error=<code>` for a spent or unknown id |
| POST | `/handoff/continue` | form `h`, Origin = baseURL | 302 to `<redirect>?code=`; 403 from any other origin; the sign-in page without a session |
| POST | `/handoff/redeem` | `{ code, verifier }` | `{ token, user, session }` as a bearer answer, no cookie; 400 `invalid_body`, `invalid_token`, `token_expired`; 429 `rate_limited` |

Without a `passkey` config none of these routes exist, and the router answers 404.

Without a `password` config none of the password routes exist, and the router answers 404.

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
password form with a Forgot password button. Every method ends by visiting
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
`https` URL that is not on a loopback host. The handoff confirm page adds the source of the matched dev redirect to `form-action`: its scheme (`exp:`), or the origin of a loopback URL (`http://127.0.0.1:8081`). A dev redirect on `[::1]` cannot be listed. Use `127.0.0.1`. `signInPage`
replaces the page; the function gets the base path, the continue path,
the enabled methods, and the script nonce, and must put the nonce on its
script tag. The `methods` input has the flags `magicLink`, `google`,
`apple`, `passkey`, and `password`. `password` is true when the config
has a `password` section. `@tempo-auth/handoff` (plan 5b) does the app side.

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
| `password-change:user:<userId>` | 10 per 15 minutes |

The `password:email` limit is a trade-off: 10 wrong tries from anyone stop
password sign-in for that address for 15 minutes. The magic link still
works for the owner. Without the limit, a guess run on one account from
many IP addresses has no bound. Recorded 2026-10-10 by the plan 8 final
fix wave.

The reset POST checks its limit, then reads the link row, then the policy,
then the breach check, then hashes. A transaction consumes the link first.
A spent or expired link costs no breach call and no hash.

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
- Core at version 4 needs the `0004_schema_v4` migration in both adapters. Version 4 adds the password table.
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
