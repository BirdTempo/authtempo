---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": minor
---

Add the error codes `body_too_large` (413) and `body_busy` (503). Core reads at most the cap of each route of a request body, and refuses a longer body before any parse. The cap is 64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes. A JSON body nested deeper than 16 or with more than 4096 items answers `invalid_body` before the parse. A form body of more than 128 pairs gets the refusal of a bad form before the parse, at the SAML ACS too. The body reads of the routes with a cap above 64 KiB hold at most 16 MiB at once in one isolate. A read past it answers `body_busy` (503) with `Retry-After`. The compatibility package reads each request body with core's capped reader, at the cap of the core route of the path. Past that cap it answers `PAYLOAD_TOO_LARGE` (413) at its first read. Past the budget of the large reads it answers `SERVICE_UNAVAILABLE` (503). Before its read of an SSO connection write, it runs core's limit of the SSO manager writes of the user. Core counts that write once.
