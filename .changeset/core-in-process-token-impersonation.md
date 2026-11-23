---
"@authtempo/core": patch
"@authtempo/compat-better-auth": patch
---

The in-process token writes now refuse a session of an impersonation, as their routes do. `auth.api.tokens.create` and `auth.api.tokens.update`, and `auth.api.organizationTokens.create`, `update`, and `revoke`, answer `impersonation_session` with status 403 for such a session. They make no token, change no token, and write no audit row. Before, an operator who acted as a member could make a token that outlived the impersonation, and the organization audit named the member as the actor. `auth.api.organizationTokens.revoke` takes a new `session` option. `createApiKey`, `updateApiKey`, and `deleteApiKey` of the Better Auth compat layer pass the session of the headers, so they refuse an impersonation with the code `FORBIDDEN`. A server call that names `userId` and has no headers works as before.
