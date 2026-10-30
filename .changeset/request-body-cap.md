---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": minor
---

Add the error code `body_too_large` (413). Core reads at most the cap of each route of a request body (64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes) and refuses a longer body before any parse. A JSON body nested deeper than 16 or with more than 4096 items answers `invalid_body` before the parse.
