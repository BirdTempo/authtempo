---
"@authtempo/core": patch
"@authtempo/compat-better-auth": patch
---

The in-process token writes now refuse a session of an impersonation, as their routes do. `auth.api.tokens.create` and `auth.api.tokens.update`, and `auth.api.organizationTokens.create`, `update`, and `revoke`, answer `impersonation_session` with status 403 for such a session. They make no token, change no token, and write no audit row. Before, an operator who acted as a member could make a token that outlived the impersonation. The organization audit then named the member as the actor. `auth.api.organizationTokens.revoke` takes a new `session` option. In the Better Auth compat layer, `createApiKey`, `updateApiKey`, and `deleteApiKey` of an organization key pass the session of the headers. So they refuse an impersonation with the code `FORBIDDEN`. `deleteApiKey` of a user key does not refuse an impersonation, as its core route does not. `updateApiKey` and `deleteApiKey` of an organization key now also use the session proof rule of plan 12p, as the routes do. So a session from before the proof of its address gets `email_unverified`. A server call that names `userId` and has no headers works as before.
