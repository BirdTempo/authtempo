---
title: Limits
description: Every rate limit of core with its key, window, and maximum, and the counts that core keeps in its rows.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - packages/core/README.md "Limits in version 1"
  - packages/core/README.md "Limits"
  - docs/superpowers/plans/2026-10-14-09h-housekeeping.md
  - docs/superpowers/plans/2026-10-14-12e-oauth-provider-v2.md
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 13"
  - docs/superpowers/plans/2026-10-14-12d-sso-scim.md
  - docs/superpowers/plans/2026-10-14-12i-sign-in-additions.md "Task 4"
  - docs/superpowers/plans/2026-10-14-12i-sign-in-additions.md "Task 20"
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 5"
  - docs/superpowers/plans/2026-10-15-12f2-operator-users.md "Task 3"
---

**For:** an operator who sizes the limits of a deployment, or a developer who reads a `rate_limited` answer.

**What it does:** this page lists each limit that core asks the limiter for, and each count that core keeps in a row. A full limit answers 429 `rate_limited`.

## Before you start

- Read [Set up a shared limiter](/docs/guides/limiter/). The default limiter counts per isolate, so these numbers hold only with a shared limiter.

## The rate limits

A key ends in the address, the IP, or the user id. A request with no client IP uses `unknown` in place of the IP.

The first two parts of a key are its family, such as `magic-link:email`. A refusal emits the event `limit.hit` with the family and no part of the key. Each family of `LIMIT_FAMILIES` has one row here, and a site check holds the table to the code.

| Key | Window | Maximum | Flow |
| --- | --- | --- | --- |
| `magic-link:ip:<ip>` | 15 minutes | 20 | Magic link request |
| `magic-link:email:<email>` | 15 minutes | 5 | Magic link request |
| `social-start:ip:<ip>` | 15 minutes | 30 | Social start and link start, for every provider |
| `social-link:user:<userId>` | 15 minutes | 10 | Link start of a provider, after the start key |
| `passkey-options:ip:<ip>` | 15 minutes | 30 | Passkey sign-in options and re-authentication options |
| `passkey-verify:ip:<ip>` | 15 minutes | 20 | Passkey sign-in verify and passkey sign-up verify |
| `passkey-sign-up:ip:<ip>` | 1 hour | 10 | Passkey sign-up options, after the name rule and the sign-up rule, before the captcha |
| `passkey-sign-up:all-day:deployment` | 24 hours | `passkey.signUp.dailyCap`, default 1000 | Passkey sign-up options, after the per-IP limit and the captcha. It needs a shared limiter |
| `handoff-start:ip:<ip>` | 15 minutes | 30 | Handoff start |
| `handoff-redeem:ip:<ip>` | 15 minutes | 20 | Handoff redeem |
| `password-sign-up:ip:<ip>` | 1 hour | 10 | Password sign-up |
| `password-sign-up:email:<email>` | 1 hour | 5 | Password sign-up |
| `password:ip:<ip>` | 15 minutes | 20 | Password sign-in |
| `password:email:<email>` | 15 minutes | 10 | Password sign-in |
| `password:user:<userId>` | 15 minutes | 10 | Password check of a user with no address, in place of the address key |
| `password-resend:ip:<ip>` | 15 minutes | 20 | Verify mail resend |
| `password-resend:email:<email>` | 15 minutes | 3 | Verify mail resend |
| `password-verify-code:ip:<ip>` | 15 minutes | 30 | Sign-up code verify, before the per-address limit |
| `password-verify-code:email:<email>` | 15 minutes | 10 | Sign-up code verify. With `maxAttempts` wrong tries per code (5 by default), it bounds the guesses on one address |
| `password-verify-code:email-day:<email>` | 24 hours | 10 | Sign-up code mails, at the sign-up and each resend, before any read. With `maxAttempts` tries per code, one address gets at most 10 times `maxAttempts` guesses a day |
| `password-reset:ip:<ip>` | 15 minutes | 20 | Reset request |
| `password-reset:email:<email>` | 15 minutes | 5 | Reset request |
| `password-reset-post:ip:<ip>` | 15 minutes | 20 | Reset form post |
| `password-change:user:<userId>` | 15 minutes | 10 | Password change |
| `otp:ip:<ip>` | 15 minutes | 20 | Email code request, both purposes |
| `otp:email:<email>` | 15 minutes | 3 | Email code request, both purposes, and the re-authentication code |
| `otp:email-day:<email>` | 24 hours | 20 | Email code request, both purposes, and the re-authentication code |
| `otp-verify:ip:<ip>` | 15 minutes | 30 | Email code verify, reset, re-authentication code, and change-of-address code |
| `otp-verify:email:<email>` | 15 minutes | 10 | Email code verify, reset, re-authentication code, and change-of-address code |
| `phone-otp:ip:<ip>` | 15 minutes | 10 | Phone code request and phone add, before the read of the number |
| `phone-otp:phone:<phone>` | 15 minutes | 3 | Phone code request, after the form and region checks |
| `phone-otp:phone-day:<phone>` | 24 hours | 10 | Phone code request, after the form and region checks |
| `phone-otp:all-day:deployment` | 24 hours | `phone.dailyCap`, default 1000 | Every SMS of the deployment, each code and each note to a taken number, before the row and the send. It needs a shared limiter. For a phone code request, it counts after the answer |
| `phone-verify:ip:<ip>` | 15 minutes | 30 | Every phone code check |
| `phone-verify:phone:<phone>` | 15 minutes | 10 | Phone sign-in code check |
| `phone-add:user:<userId>` | 15 minutes | 3 | Phone add, after the fresh rule and before the request limits. The note to a taken number counts too |
| `phone-add:phone:<phone>` | 24 hours | 10 | Phone add, over every user, after the form and region checks. The note to a taken number counts too |
| `anonymous:ip:<ip>` | 1 hour | 10 | Anonymous sign-in that makes a user, before the captcha. A live anonymous session answers itself and counts nothing |
| `anonymous:all-day:deployment` | 24 hours | `anonymous.dailyCap`, default 1000 | Anonymous sign-in that makes a user, after the per-IP limit and the captcha. It needs a shared limiter |
| `anonymous-delete:user:<userId>` | 1 hour | 5 | Anonymous delete, after the check that the user is anonymous |
| `totp-code:user:<userId>` | 15 minutes | 10 | Every second factor code check: a TOTP code, a backup code, or an email code |
| `totp-code:user-day:<userId>` | 24 hours | 30 | Every second factor code check |
| `totp-setup:user:<userId>` | 15 minutes | 5 | The password check of the TOTP setup, of each method enable, and of the method disable, on one budget |
| `totp-verify:ip:<ip>` | 15 minutes | 30 | Second factor challenge |
| `second-factor-passkey:ip:<ip>` | 15 minutes | 30 | The passkey options of a second factor challenge |
| `second-factor-email:user:<userId>` | 15 minutes | 5 | Second factor email code send |
| `totp:email-day:<email>` | 24 hours | 20 | Second factor email code send |
| `invite:user:<userId>` | 15 minutes | 20 | Invite, per inviting user |
| `invite:email:<email>` | 1 hour | 5 | Invite, per invited address |
| `invitation-accept:ip:<ip>` | 15 minutes | 20 | Invitation accept |
| `slug-check:user:<userId>` | 1 minute | 60 | Organization slug check, create, and rename to a new slug, on one budget, before the slug read |
| `token-create:user:<userId>` | 1 hour | 20 | API token create, and organization token create: one key for both |
| `token-use:tk:<tokenId>` | The token's `rateLimitSeconds` | The token's `rateLimitMax` | Each call of one API token with a window, after the hash lookup and before the quota spend. The app sets the window in process, or `tokens.defaultRateLimit` fills it. A change of the window starts a new count |
| `token-use:to:<tokenId>` | The token's `rateLimitSeconds` | The token's `rateLimitMax` | Each call of one organization token with a window, by the rule of `token-use:tk:<tokenId>` |
| `reauth:user:<userId>` | 15 minutes | 10 | Re-authentication, right or wrong |
| `reauth-mail:user:<userId>` | 15 minutes | 3 | Re-authentication code mail, before the address keys of every mailed code |
| `session-revoke:user:<userId>` | 15 minutes | 30 | Session revoke and revoke-others together |
| `user-update:user:<userId>` | 15 minutes | 30 | Profile update |
| `passkey-rename:user:<userId>` | 15 minutes | 30 | Passkey rename, also for an unknown id. A refused name counts no try |
| `email-change:user:<userId>` | 1 hour | 5 | Change of address request |
| `email-change:email:<email>` | 15 minutes | 3 | Change of address request, per new address |
| `email-change-confirm:ip:<ip>` | 15 minutes | 20 | Change of address link confirm |
| `unlink:user:<userId>` | 15 minutes | 10 | Unlink of a provider, also for an unknown id |
| `user-delete:user:<userId>` | 1 hour | 5 | Account delete and the request of its mailed link, also when it answers `sole_owner`. A stale session counts no try |
| `user-delete-confirm:ip:<ip>` | 15 minutes | 20 | Account delete link confirm. A malformed token counts no try |
| `token-live:session:<sessionId>` | 1 minute | 120 | The live check of a session JWT |
| `operator:ip:<ip>` | 1 hour | 5 | Operator key rotation, right or wrong secret |
| `operator-secrets:ip:<ip>` | 1 hour | 120 | Operator secret status, secret rewrap, and info, one count for the three, right or wrong secret. A rewrap of 100 000 rows at 1000 rows per call needs 100 calls |
| `operator-users:ip:<ip>` | 1 hour | 600 | Every secret call to the user, session, and audit routes, right or wrong secret. `OPERATOR_USERS_PER_IP` |
| `operator-users:secret:<name>` | 1 hour | 600 | Every call of one operator secret to the user, session, and audit routes, after the secret matches, from any IP. `OPERATOR_USERS_PER_SECRET` |
| `operator:user:<userId>` | 1 hour | 600 | Every call of a platform operator, after the operator user guard passes |
| `operator-impersonate:user:<userId>` | 1 hour | 20 | Impersonation starts of one platform operator |
| `operator-delete:actor:<kind>:<id>` | 1 hour | 100 | Every call of one actor to the operator delete route, before the body and the scope check. The subject is `secret:<name>` or `user:<userId>`. A delete cannot be undone, so the count bounds what a leaked credential destroys. `OPERATOR_DELETE_PER_ACTOR` |
| `operator-create:actor:<kind>:<id>` | 1 hour | 200 | Every call of one actor to the operator create route, before the body and the scope check. The subject is `secret:<name>` or `user:<userId>`. Each create can mail the person once, so a leaked credential must not become a mail cannon. `OPERATOR_CREATE_PER_ACTOR` |
| `user-invite-confirm:ip:<ip>` | 15 minutes | 20 | The confirm POST of an invitation link, before the token check, so a malformed token counts too. `INVITE_CONFIRM_PER_IP` |
| `oauth-register:ip:<ip>` | 1 hour | 10 | OAuth client registration |
| `oauth-authorize:ip:<ip>` | 15 minutes | 60 | OAuth authorize, and each `GET /oauth/device` with no session. The count runs before a request is held for the sign-in |
| `oauth-token:ip:<ip>` | 15 minutes | 60 | OAuth token and revoke. A device poll counts here unless it names a known code and the client of that code. A failed client auth of any poll counts here too |
| `oauth-token-origin:ip:<ip>` | 15 minutes | 60 | The origin check of a foreign origin at the token endpoint and its preflight |
| `oauth-device:ip:<ip>` | 15 minutes | 30 | The device authorization request, before the client auth, so a failed auth counts too |
| `oauth-device-poll:code:<hash>` | The code life | One per `interval`, plus 10: 130 for the defaults | Each poll of one known device code by the client of the code, before the client auth. The client is the Basic id, the assertion `sub`, or the form `client_id`. A poll under another client id counts on `oauth-token:ip`. A poll past the limit answers `slow_down` |
| `oauth-device-verify:ip:<ip>` | 15 minutes | 20 | Each post of the device page from one IP |
| `oauth-device-verify:session:<sessionId>` | 15 minutes | 5 | Each post of the device page from one session: a guessed user code costs one |
| `oauth-device-verify:code:<hash>` | 15 minutes | 10 | Each post of the device page that finds one live user code, by its keyed hash. It bounds how many sessions see the consent of one code |
| `oauth-introspect:ip:<ip>` | 1 minute | 600 | OAuth introspection, before the client auth, so a failed auth counts too |
| `oauth-introspect:client:<clientId>` | 1 minute | 600 | OAuth introspection by one resource server, after its client auth |
| `oauth-end-session:ip:<ip>` | 15 minutes | 60 | OIDC end-session, GET and POST together, before the hint check |
| `oauth-credentials:client:<clientId>` | 1 minute | 120 | The `client_credentials` grant of one client, after its client auth. `oauth-token:ip` counts each request first, so a service on one IP gets 60 tokens per 15 minutes. Keep the token until its `expires_in` ends, and ask for a new one only then |
| `sso-discover:ip:<ip>` | 15 minutes | 30 | SSO discovery, JSON or form |
| `sso-start:ip:<ip>` | 15 minutes | 30 | SSO start of an OIDC or a SAML connection, before the connection read |
| `sso-acs:ip:<ip>` | 15 minutes | 60 | SAML form post to the ACS |
| `sso-domain-verify:org:<organizationId>` | 1 hour | 10 | SSO domain verify, before any resolver |
| `sso-manage:user:<userId>` | 15 minutes | 30 | Each SSO domain, SSO connection, and SCIM token route, before the manager guard |
| `scim-auth:ip:<ip>` | 15 minutes | 60 | Each failed SCIM token check: a missing, wrong, expired, or revoked token. A valid token never counts here |
| `scim:token:<tokenId>` | 10 minutes | 1200 | Each call of one SCIM token, after the token check |
| `username:user:<userId>` | 1 hour | 5 | Username set, after the fresh rule and the name rules |
| `username-available:ip:<ip>` | 15 minutes | 30 | Username check, before the name rules |
| `password:username:<username>` | 15 minutes | 10 | Password sign-in by username, on the stored form, after the name rules |
| `password:phone:<phone>` | 15 minutes | 10 | Password sign-in by phone, after the E.164 check |
| `multi-session:ip:<ip>` | 15 minutes | 60 | Each multi-session route: the list, the switch, and the sign-out of one session, before the session read |
| `id-token-nonce:ip:<ip>` | 15 minutes | 60 | The nonce of the ID-token route, before the nonce write |
| `id-token:ip:<ip>` | 15 minutes | 30 | The ID-token sign-in, before the nonce spend and the token verify |

For an IPv4 address, `<ip>` is the address. An IPv4-mapped IPv6 address gives its IPv4 form. Any other IPv6 address gives its `/64` prefix, written `2001:db8:1:2::/64`. The users of one `/64` share each per-IP count. A host that gives one `/64` to many tenants makes them share each count. A request with no client IP keys `unknown`. A value that is not an IP stays as given, for example the answer of a custom `clientIp`. Core exports `ipKey`, so an app's own limiter can key the same way.

`otp:email-day:<email>` and `totp:email-day:<email>` read one cap of 20 per 24 hours: one number, two keys. The keys are apart because an email code request needs no password. A person who knows the address must not use up the mails of the second factor.

`password:email`, `password:username`, and `password:phone` count apart, one key for each kind of identifier. So from many IPs, one account with an address, a username, and a phone takes up to 30 guesses per 15 minutes. This is a known residual. A count per account would close it, but its 429 would tell that a phone and an address name one account. `password:ip` bounds each IP at 20 guesses.

A phone code request and a phone add send their SMS after the answer. So a refusal of `phone-otp:all-day:deployment` at a request or an add gives no 429. The answer stays `{ sent: true }`, and core writes one `sms.not_sent` line with the reason `capped`. A 429 there would come only on the branch that sends, so its time and status would tell whether a number has an account. Watch the line: it is the only sign that the cap stops codes.

The phone add counts on `phone-add:phone`, not on the two `phone-otp` keys of a number. So an add by another account spends no sign-in count of the person who holds the number.

`phone-otp:all-day:deployment` counts in a fixed window that opens at the first send. The count starts again when the window ends. So up to 2 × `dailyCap` sends can go out in a short span across the end of a window. The stored key holds the maximum, so a new `dailyCap` starts a new count.

The per-number phone keys read the number as given. Two E.164 forms can name one handset, such as `+4407700900123` and `+447700900123`. Each form then gets its own count. Core uses no phone library and does not rewrite a number. Give an SMS port that refuses a form that its supplier rewrites.

The stored key of an owned limiter is the key, the seconds, and the maximum, joined by U+001F.

## The device code

A user code of the device grant has 8 letters of a set of 20, about 34.5 bits. With n live codes, one guess passes with p = n / 20^8, about n × 3.9 × 10⁻¹¹.

The device page counts each post on three keys of 15 minutes: the session, the IP, and a found code. The three owned limiters open a window at the first call after the last window ended. So a window that opened just before a code started still takes guesses in the code's first minutes. One key then gets at most max − 1 + max × ceil(life / 15 minutes) guesses at one code.

| Code life | Per session | Per IP |
| --- | --- | --- |
| 10 minutes, the default | 9 guesses, p ≈ n × 3.5 × 10⁻¹⁰ | 39 guesses, p ≈ n × 1.5 × 10⁻⁹ |
| 30 minutes, the most | 14 guesses, p ≈ n × 5.5 × 10⁻¹⁰ | 59 guesses, p ≈ n × 2.3 × 10⁻⁹ |

The limiter port does not promise this window shape. A custom limiter with windows on the clock allows 10 guesses per session and 40 per IP for a 10-minute code. An attacker with k addresses multiplies the IP bound by k. A limiter that counts per isolate multiplies each bound by the count of isolates.

## The counts in rows

These counts live in their rows, so they hold under every limiter.

| Count | Maximum | The answer |
| --- | --- | --- |
| Wrong guesses of one email code | `emailOtp.maxAttempts`, 5 by default | `too_many_attempts` |
| Wrong guesses of one phone code | `phone.maxAttempts`, 3 by default | `too_many_attempts` |
| Wrong codes of one second factor challenge | 5 | `too_many_attempts` |
| Email code sends of one second factor challenge | 3 | `rate_limited` |
| API tokens of one user | 50 | `token_limit` |
| Calls of one API token with a quota | Its `remaining`. A due refill sets it to `refillAmount` | `token_exhausted`. One compare-and-set per try. A lost try tries again while another call spent, 20 tries at most, then `conflict` |
| The `metadata` of one API token | 4096 bytes as JSON | `invalid_body` |
| Memberships of one user | `organizations.limits.perUser` | `organization_limit` |
| Members of one organization | `organizations.limits.membersPerOrganization` | `member_limit` |
| Pending invitations of one organization | `organizations.limits.pendingInvitationsPerOrganization` | `invitation_limit` |
| The `metadata` of one organization | 4096 bytes as JSON | `invalid_body` |
| Teams of one organization | `organizations.limits.teamsPerOrganization` | `team_limit` |
| Members of one team | `organizations.limits.membersPerTeam`. A team member add and an accept count | `team_member_limit` |
| Stored roles of one organization | `organizations.dynamicRoles.maxPerOrganization`, 50 by default | `role_limit` |
| Live tokens of one organization | 50 | `organization_token_limit` |
| SSO connections of one organization | `sso.limits.connectionsPerOrganization`, 10 by default | `connection_limit` |
| SSO domains of one organization | `sso.limits.domainsPerOrganization`, 20 by default | `domain_limit` |
| Live SCIM tokens of one organization | 2 | `token_limit` |
| Members of one SCIM group | 10000 | SCIM 400 `invalidValue` |
| Members of a group that one SCIM request names | 1000, from the D1 Free budget of 50 queries, on every store | SCIM 400 `invalidValue` |
| Members of a group that one SCIM request takes away | 1000 | SCIM 400 `invalidValue` |
| Members whose role one rename or delete of a mapped SCIM group computes | 1000 | SCIM 400 `invalidValue` |
| Results of one SCIM list page | 100 | The page ends there |
| One SCIM request body | 1 MB | SCIM 413 |
| One SAML form at the ACS | 1 081 519 bytes | `sso_failed` |
| One decoded SAML Response | 256 KB, depth 64, 5000 elements | `sso_failed` |
| The metadata XML of a provider | 100 KB | `invalid_body` |

## The lives

| Item | Life |
| --- | --- |
| Session | `session.ttlDays`, 30 days by default, with a sliding refresh after `session.slidingRefreshDays`. With `session.absoluteDays`, at most that many days after the sign-in |
| Magic link | `magicLink.ttlMinutes`, 15 minutes by default |
| Email code | `emailOtp.ttlMinutes`, 10 minutes by default |
| Phone code | `phone.ttlMinutes`, 5 minutes by default |
| Reset link | `password.resetTtlMinutes`, 15 minutes by default |
| Social state and binding cookie | 10 minutes |
| Passkey challenge | 5 minutes |
| Handoff code | 2 minutes |
| Second factor challenge | 5 minutes |
| Second factor setup | 15 minutes |
| Invitation | `organizations.invitationTtlDays`, 7 days by default |
| Session JWT | `jwtMint.ttlMinutes`, 15 minutes by default |
| OAuth authorization code | `oauth.codeTtlMinutes`, 5 minutes by default |
| OAuth held request | 10 minutes |
| OAuth refresh token | `oauth.refreshTtlDays`, 30 days by default |
| OAuth device code and user code | `oauth.device.codeTtlMinutes`, 10 minutes by default |
| Pending SSO domain | 7 days |
| Recheck of a verified SSO domain | 30 days after its last check. Three failures that span 72 hours lose the domain |
| SSO state of an OIDC start, and SAML request | 10 minutes |
| SCIM token | `expiresInDays`, 1 to 730, or no end |

## Next

- [Set up a shared limiter](/docs/guides/limiter/)
- [The threat model](/docs/concepts/threat-model/)
- [Error codes](/docs/reference/errors/#rate_limited)
