---
"@authtempo/core": minor
---

The new hook group `hooks.request` has two points, `before` and `after`. They run in `handle`, around the handler of each matched route, after each rule of the router. An in-process call of `auth.api` runs neither.

Each point gets the route key, the path parameters, the URL, the headers, the IP, and `json()`. `json()` answers the JSON body through the cap of the route, and the handler then reads the same bytes. It answers `undefined` on the SCIM routes, on the SAML ACS, and on the two SSO connection writes.

A `hookRefusal` in `before` answers 403 `hook_refused`, and the handler does not run. Any other throw answers 500 `hook_failed`. With this hook, each route can answer these two codes. `after` also gets the status and the code, and it cannot change the answer.

The event `hook.after_failed` now has an optional `rowId`: a request has no row.
