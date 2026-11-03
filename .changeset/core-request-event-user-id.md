---
"@authtempo/core": minor
---

The `request` event has a new optional field `userId`. It is the user of the session that the route resolved for that request. The field is absent when no session resolved. So an operator can tie a refusal of a route, such as a 429 or a 503 of an SSO connection write, to an account.

The compat entry `@authtempo/core/compat` exports `ID_TOKEN_PROVIDERS`, the providers of the ID-token route. A compatibility package takes its list from it.

A 401 of the check after the body read of an SSO connection write sends no renewed session cookie, because the session ended. A 403 of that check keeps the cookie, because the session is live.
