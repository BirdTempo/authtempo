---
"@authtempo/core": minor
"@authtempo/compat-better-auth": minor
"@authtempo/next": minor
---

Breaking: core reads the old session cookie `tempo_session` no more, and the router does not move it.

Version 0.1 read `tempo_session` when a request had no `__Host-tempo_session`, and moved the token to the new name. That read is gone. A browser that holds only the old cookie signs in again. The Better Auth shim and the proxy of `@authtempo/next` read the old name no more.

`@authtempo/core/credentials` no longer exports `LEGACY_COOKIE_NAME`. `sessionCookieNames()` answers `{ cookieName }` only, and `readSessionToken` reads no `legacyCookieName`. The resolved config has no `legacyCookieName`.

A sign-out clears the session cookie only. `LEGACY_SESSION_COOKIE` stays: the config refuses that name for each other cookie of core, and the Expo storage key of the shim holds it.
