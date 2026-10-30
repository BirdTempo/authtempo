---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": minor
---

Add the error code `body_too_large` (413). Core reads at most the cap of each route of a request body (64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes) and refuses a longer body before any parse. A JSON body nested deeper than 16 or with more than 4096 items answers `invalid_body` before the parse. A form body of more than 128 pairs gets the refusal of a bad form before the parse, at the SAML ACS too. The compatibility package reads each request body with core's capped reader, at the cap of the core route of the path, and answers `PAYLOAD_TOO_LARGE` (413) at its first read. Before its read of an SSO connection write, it runs core's limit of the SSO manager writes of the user, and core counts that write once.
