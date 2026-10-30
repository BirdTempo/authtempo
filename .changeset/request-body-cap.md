---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": minor
---

Add the error code `body_too_large` (413). Core reads at most 8 MiB of a request body and refuses a longer body before any parse.
