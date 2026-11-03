---
"@authtempo/core": minor
---

The `request` event has a new optional field `userId`. It is the user of the session row that the request's token names, read in full or by a peek. The route's session read sets it, and so do the two refusal steps of the router, which run before the route. So a refusal names the account of the token, a banned one too. On a request with no session, the field is absent. So an operator can tie a refusal of a route, such as a 429 or a 503 of an SSO connection write, to an account.

The compat entry `@authtempo/core/compat` exports `ID_TOKEN_PROVIDERS`, the providers of the ID-token route. A compatibility package takes its list from it.

A 401 of the check after the body read of an SSO connection write sends no renewed session cookie, because the session ended. A 403 of that check keeps the cookie, because the session is live.
