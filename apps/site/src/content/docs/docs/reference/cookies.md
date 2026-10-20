---
title: Cookies
description: Every cookie that core sets, with its attributes, path, life, and the flow that sets it.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.1
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.3
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 15
  - packages/core/src/http/cookies.ts
  - packages/core/src/engine/sessions.ts
  - packages/core/src/http/impersonation-rules.ts
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md
---

**For:** a developer who writes the cookie text of a privacy page, or checks why a browser drops a cookie.

**What it does:** this page lists the four cookies of core. Each is `HttpOnly` and `Secure`, and holds no data but a token.

## Before you start

- Read [Run the app on another origin](/docs/guides/split-origins/) for the choice of `SameSite`.

## The cookies

| Name | Path | SameSite | Life | Set by |
| --- | --- | --- | --- | --- |
| `__Host-tempo_session` | `/` | `cookie.sameSite`, `Lax` by default | `session.ttlDays`, at most `session.absoluteDays` | Every sign-in in a browser |
| `__Secure-tempo_session_oauth` | `<basePath>/social` | `None` | 10 minutes | The social start |
| `tempo_totp_trust` | `<basePath>/` | `cookie.sameSite` | `totp.trustDays` | A second factor verify with `trustDevice` |
| `__Host-tempo_session_actor` | `/` | `cookie.sameSite`, `Lax` by default | `operator.impersonation.ttlMinutes` | The start of an [impersonation](/docs/reference/routes/#impersonation) |

The `__Host-` prefix makes a browser refuse the session cookie unless it is `Secure`, has `Path=/`, and has no `Domain`. A host on a sibling subdomain cannot set it. The names keep the old product name tempo-auth for compatibility.

- `cookieName` renames the session cookie. The binding cookie is that name with no `__Host-` or `__Secure-` prefix, plus `__Secure-` in front and `_oauth` at the end.
- The old session cookie `tempo_session`: for one release, a request that carries it and no `__Host-tempo_session` stays signed in. The answer sets `__Host-tempo_session` with the same token and clears `tempo_session`. Only the default name gets this move. `auth.handle`, `auth.session`, and `auth.caller` read the old cookie. Only `auth.handle` moves it.
- The Better Auth shim uses the default name, so it gets the same move. Its `api.getSession` reads the old cookie too. The Expo storage key keeps the name `<storagePrefix>_tempo_session`.
- `totp.trustCookieName` renames the trust cookie.
- The actor cookie is the session cookie name with `_actor` at the end, so `cookieName` renames it too. During an impersonation it holds the operator's own `ts_` token, and the session cookie holds the token of the impersonation session. The stop clears it and puts the operator's token back in the session cookie.
- A sign-out clears the cookie. A sign-out with the old cookie clears both names. After a reset or a claim, the next `GET /session` clears it.

## Deploy note

The move lasts one release. Row 12j removes it in the next release.

- A browser that calls no core route in this release keeps only `tempo_session`. A call to an app route that reads `auth.session`, `auth.caller`, or the shim's `api.getSession` keeps it signed in, but sets no new cookie. After the next release, that browser is signed out.
- Core sets every cookie with `Secure`, whatever its name. A browser keeps no `Secure` cookie that a plain http page sets, except on `localhost`. So a staging or LAN host on plain http keeps no session, before and after this release. The `__Host-` prefix adds no new failure there. `cookieName` does not change this: core accepts any name, and sets `Secure` on each. Serve that host over https.
- A social sign-in that is open during the deploy fails once with `invalid_token`. Core no longer reads the old binding cookie `tempo_session_oauth`, and the binding cookie lives 10 minutes. Start the sign-in again.

## The rules

- The session cookie holds a `ts_` token. The binding cookie holds the binding token of one social flow. The trust cookie holds a `td_` token. The actor cookie holds a `ts_` token.
- After a sliding refresh, an app route that calls `auth.session` must send `auth.sessionCookie(request, resolved)`. Otherwise the browser drops the cookie at its old `Max-Age`.
- A reader that cannot set a cookie, such as a server render, calls `auth.session(request, { refresh: false })`. That read does not slide the expiry and writes nothing, so the browser's own `GET /auth/session` still gets the renewed cookie.
- The binding cookie is `SameSite=None`, because Apple posts its callback from its own site, and a browser sends no `Lax` cookie on that post.
- One binding cookie lives in each browser. A second social start replaces it, and the first flow then answers `invalid_token`.
- The session cookie is a `__Host-` cookie. The trust cookie is a plain host cookie on the auth path. A host on a sibling subdomain can set a cookie of that name for the parent domain.
- A native app passes `credentials: "omit"`. Core reads the cookie before the bearer header, so a stray cookie replaces the bearer session.

## Next

- [Tokens and prefixes](/docs/reference/tokens/)
- [Sign in with Google and Apple](/docs/guides/social/)
- [The threat model](/docs/concepts/threat-model/)
