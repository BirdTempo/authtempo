---
title: Cookies
description: Every cookie that core sets, with its attributes, path, life, and the flow that sets it.
type: reference
sources:
  - packages/core/src/http/cookies.ts
  - packages/core/src/engine/sessions.ts
  - packages/core/src/http/impersonation-rules.ts
  - packages/core/src/engine/last-method.ts
  - packages/core/src/engine/multi-session.ts
  - packages/core/src/engine/password.ts
---

**For:** a developer who writes the cookie text of a privacy page, or checks why a browser drops a cookie.

**What it does:** this page lists the seven cookies of core. Each is `Secure`. Six are `HttpOnly` and hold no data but tokens. The last method cookie is readable by page scripts and holds the name of a sign-in method.

## Before you start

- Read [Run the app on another origin](/docs/guides/split-origins/) for the choice of `SameSite`.

## The cookies

| Name | Path | SameSite | Life | Set by |
| --- | --- | --- | --- | --- |
| `__Host-tempo_session` | `/` | `cookie.sameSite`, `Lax` by default | `session.ttlDays`, at most `session.absoluteDays` | Every sign-in in a browser |
| `__Secure-tempo_session_oauth` | `<basePath>/social`, or the path of the provider's `redirectURI`; `<basePath>/sso` for an SSO sign-in | `None` | 10 minutes | The social start and the SSO start |
| `tempo_totp_trust` | `<basePath>/` | `cookie.sameSite` | `totp.trustDays` | A second factor verify with `trustDevice` |
| `__Host-tempo_session_actor` | `/` | `cookie.sameSite`, `Lax` by default | `operator.impersonation.ttlMinutes` | The start of an [impersonation](/docs/reference/routes/#impersonation) |
| `__Host-tempo_last_method` | `/` | `Lax` | `lastMethod.days`, 30 by default | A browser sign-in while `lastMethod` is on |
| `__Host-tempo_sessions` | `/` | `cookie.sameSite`, `Lax` by default | `session.ttlDays`, at most `session.absoluteDays` | A browser sign-in of another user while `multiSession` is on |
| `__Host-tempo_signup` | `/` | `Lax` | `magicLink.ttlMinutes`, or `password.verifyCode.ttlMinutes` with the code | A password sign-up, and a resend that carries it |

The `__Host-` prefix makes a browser refuse the session cookie unless it is `Secure`, has `Path=/`, and has no `Domain`. A host on a sibling subdomain cannot set it. The names keep the old product name tempo-auth for compatibility.

- `cookieName` renames the session cookie. The binding cookie is that name with no `__Host-` or `__Secure-` prefix, plus `__Secure-` in front and `_oauth` at the end.
- The old session cookie `tempo_session`: core reads it no more since 0.2.0. Version 0.1 read it and moved it to `__Host-tempo_session`. A browser that holds only the old cookie signs in again. Core still refuses the old name for each other cookie of core.
- The Better Auth shim uses the default name, and it reads the old cookie no more. The Expo storage key keeps the name `<storagePrefix>_tempo_session`.
- `totp.trustCookieName` renames the trust cookie.
- `lastMethod.cookieName` renames the last method cookie. Core refuses a name of another cookie of core.
- The bag cookie of multi-session is the session cookie name with `s` at the end, so `cookieName` renames it too. It holds the other `ts_` tokens of the browser, joined by `.`, at most `multiSession.max` minus one. It has the attributes of the session cookie. Core reads it only on the multi-session routes and at a browser sign-in, never as the credential of a request. `POST /sign-out` ends each of its sessions and clears it.
- The actor cookie is the session cookie name with `_actor` at the end, so `cookieName` renames it too. During an impersonation it holds the operator's own `ts_` token, and the session cookie holds the token of the impersonation session. The stop clears it and puts the operator's token back in the session cookie.
- A sign-out clears the cookie. After a reset or a claim, the next `GET /session` clears it.

## Deploy note

The move of the old cookie `tempo_session` ended with 0.2.0.

- A browser that called no core route while the app ran 0.1 holds only `tempo_session`. With 0.2.0 that browser is signed out, and the person signs in again. The session row of the old cookie stays until it expires, or until the person ends it in the session list.
- Core sets every cookie with `Secure`, whatever its name. A browser keeps no `Secure` cookie that a plain http page sets, except on `localhost`. So a staging or LAN host on plain http keeps no session. The `__Host-` prefix adds no new failure there. `cookieName` does not change this: core accepts any name, and sets `Secure` on each. Serve that host over https.
- A social sign-in that is open during the deploy fails once with `invalid_token`. Core no longer reads the old binding cookie `tempo_session_oauth`, and the binding cookie lives 10 minutes. Start the sign-in again.

## The rules

- The session cookie holds a `ts_` token. The bag cookie holds `ts_` tokens in clear, as the session cookie does, and a token of it signs no request in. The binding cookie holds the binding token of one social flow. The trust cookie holds a `td_` token. The actor cookie holds a `ts_` token.
- The sign-up proof cookie holds the `sp_` proof of one password sign-up. Its name is fixed, and core refuses it as `cookieName` and as `lastMethod.cookieName`. A confirm that carries it keeps the password of its sign-up. Any other confirm deletes that password. A confirm clears it. For an app on another site, it is a third-party cookie, and many browsers drop it. See [the claim rule](/docs/concepts/claim-rule/#the-confirm-of-a-sign-up).
- The last method cookie holds one value of a closed set, such as `password` or `social:google`. It is not `HttpOnly`, because the sign-in page reads it to show the method of the last sign-in first. It signs no one in and names no account. Core never reads it. A bearer client gets no last method cookie.
- A provider's `redirectURI` moves its callback to that path. The binding cookie then has that path, so the browser sends it to the callback.
- With a `baseURL` list, no cookie has a `Domain`, so each host keeps its own cookies. The start sends the callback on its own host, and the sign-in ends where it started.
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
