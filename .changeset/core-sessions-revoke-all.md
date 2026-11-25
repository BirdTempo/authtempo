---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": patch
---

Add `POST /sessions/revoke-all`, `api.session.revokeAll`, and `client.sessions.revokeAll()`. The call ends every session of the user, the caller's own too, in one transaction. It also ends the second-factor challenges and the handoff codes. The trusted devices, the API tokens, and the OAuth grants stay, as with `POST /sessions/revoke-others`. The call needs a fresh session, and it shares the limit key `session-revoke:user` with the two other revoke routes. The answer is `{ ended }`, the count of ended sessions with the caller's own, and the route clears the session cookie. A session JWT of an ended session lives to its `exp`.

`POST /revoke-sessions` and `auth.api.revokeSessions` of the Better Auth compat layer now use this one call. Before, they ended the other sessions and then the caller's session in two calls. A failure of the second call left the caller signed in.
