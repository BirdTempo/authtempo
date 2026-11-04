---
"@authtempo/compat-better-auth": patch
---

Better Auth's `createApiKey` with headers now passes the session of the headers to core. So a session made before the proof of its address makes no key. A server call with `userId` and no headers keeps the rule of the user row. The enable of TOTP passes the session to the TOTP setup of core.
