---
"@authtempo/compat-better-auth": patch
---

`/sign-in/social` with an ID token takes its list of providers from core. A provider outside that list answers 501 `NOT_SUPPORTED`, and the message names the providers of core's list.
