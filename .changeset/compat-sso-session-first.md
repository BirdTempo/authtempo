---
"@authtempo/compat-better-auth": minor
---

Breaking: `/sso/delete-provider`, `/sso/request-domain-verification`, `/sso/verify-domain`, and `/sso/get-provider` answer 401 `UNAUTHORIZED` to a caller with no session. The old answer for an unknown provider was 404. Sign in before you call these paths.

Breaking: a ban of the caller's own user answers 400 `YOU_CANNOT_BAN_YOURSELF`, as Better Auth does. The old status was 409. Read 400 for this code.

These four SSO paths read the session before any byte of the body and before any storage read. A signed-in caller still gets 404 for an unknown provider. Each SSO path of the shim reads the session with no write. So core's own route does the due sliding refresh, and the answer carries the renewed session cookie.
