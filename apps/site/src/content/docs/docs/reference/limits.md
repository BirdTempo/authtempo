---
title: Limits
description: Every rate limit of core with its key, window, and maximum, and the counts that core keeps in its rows.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - packages/core/README.md "Limits in version 1"
  - packages/core/README.md "Limits"
  - docs/superpowers/plans/2026-10-14-09h-housekeeping.md
---

**For:** an operator who sizes the limits of a deployment, or a developer who reads a `rate_limited` answer.

**What it does:** this page lists each limit that core asks the limiter for, and each count that core keeps in a row. A full limit answers 429 `rate_limited`.

## Before you start

- Read [Set up a shared limiter](/docs/guides/limiter/). The default limiter counts per isolate, so these numbers hold only with a shared limiter.

## The rate limits

A key ends in the address, the IP, or the user id. A request with no client IP uses `unknown` in place of the IP.

| Key | Window | Maximum | Flow |
| --- | --- | --- | --- |
| `magic-link:ip:<ip>` | 15 minutes | 20 | Magic link request |
| `magic-link:email:<email>` | 15 minutes | 5 | Magic link request |
| `social-start:ip:<ip>` | 15 minutes | 30 | Social start, for every provider |
| `passkey-options:ip:<ip>` | 15 minutes | 30 | Passkey sign-in options |
| `passkey-verify:ip:<ip>` | 15 minutes | 20 | Passkey sign-in verify |
| `handoff-start:ip:<ip>` | 15 minutes | 30 | Handoff start |
| `handoff-redeem:ip:<ip>` | 15 minutes | 20 | Handoff redeem |
| `password-sign-up:ip:<ip>` | 1 hour | 10 | Password sign-up |
| `password:ip:<ip>` | 15 minutes | 20 | Password sign-in |
| `password:email:<email>` | 15 minutes | 10 | Password sign-in |
| `password-resend:ip:<ip>` | 15 minutes | 20 | Verify mail resend |
| `password-resend:email:<email>` | 15 minutes | 3 | Verify mail resend |
| `password-reset:ip:<ip>` | 15 minutes | 20 | Reset request |
| `password-reset:email:<email>` | 15 minutes | 5 | Reset request |
| `password-reset-post:ip:<ip>` | 15 minutes | 20 | Reset form post |
| `password-change:user:<userId>` | 15 minutes | 10 | Password change |
| `otp:ip:<ip>` | 15 minutes | 20 | Email code request, both purposes |
| `otp:email:<email>` | 15 minutes | 3 | Email code request, both purposes |
| `otp:email-day:<email>` | 24 hours | 20 | Email code request, both purposes |
| `otp-verify:ip:<ip>` | 15 minutes | 30 | Email code verify and reset |
| `otp-verify:email:<email>` | 15 minutes | 10 | Email code verify and reset |
| `totp-code:user:<userId>` | 15 minutes | 10 | Every second factor code check |
| `totp-code:user-day:<userId>` | 24 hours | 30 | Every second factor code check |
| `totp-setup:user:<userId>` | 15 minutes | 5 | The password check of the second factor setup |
| `totp-verify:ip:<ip>` | 15 minutes | 30 | Second factor challenge |
| `invite:user:<userId>` | 15 minutes | 20 | Invite, per inviting user |
| `invite:email:<email>` | 1 hour | 5 | Invite, per invited address |
| `invitation-accept:ip:<ip>` | 15 minutes | 20 | Invitation accept |
| `token-create:user:<userId>` | 1 hour | 20 | API token create |
| `operator:ip:<ip>` | 1 hour | 5 | Operator key rotation, right or wrong secret |
| `oauth-register:ip:<ip>` | 1 hour | 10 | OAuth client registration |
| `oauth-authorize:ip:<ip>` | 15 minutes | 60 | OAuth authorize |
| `oauth-token:ip:<ip>` | 15 minutes | 60 | OAuth token and revoke |

The stored key of an owned limiter is the key, the seconds, and the maximum, joined by U+001F.

## The counts in rows

These counts live in their rows, so they hold under every limiter.

| Count | Maximum | The answer |
| --- | --- | --- |
| Wrong guesses of one email code | `emailOtp.maxAttempts`, 5 by default | `too_many_attempts` |
| Wrong codes of one second factor challenge | 5 | `too_many_attempts` |
| API tokens of one user | 50 | `token_limit` |
| Memberships of one user | `organizations.limits.perUser` | `organization_limit` |
| Members of one organization | `organizations.limits.membersPerOrganization` | `member_limit` |
| Pending invitations of one organization | `organizations.limits.pendingInvitationsPerOrganization` | `invitation_limit` |
| The `metadata` of one organization | 4096 bytes as JSON | `invalid_body` |

## The lives

| Item | Life |
| --- | --- |
| Session | `session.ttlDays`, 30 days by default, with a sliding refresh after `session.slidingRefreshDays` |
| Magic link | `magicLink.ttlMinutes`, 15 minutes by default |
| Email code | `emailOtp.ttlMinutes`, 10 minutes by default |
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

## Next

- [Set up a shared limiter](/docs/guides/limiter/)
- [The threat model](/docs/concepts/threat-model/)
- [Error codes](/docs/reference/errors/#rate_limited)
