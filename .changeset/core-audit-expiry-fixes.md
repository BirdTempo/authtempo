---
"@authtempo/core": patch
"@authtempo/compat-better-auth": patch
---

The expiry notice reads the owners of an organization of exactly 100 members in full. Before, the sweep wrote a false `notice.mail_failed` with a `RangeError` for such an organization. A member or invitation act in an impersonation now writes the operator as the actor, with `data.platform: true`. This applies to the core routes and to `auth.api.cancelInvitation` of the Better Auth compat layer. The organization audit shows such an act as `platform`, with no IP and no user agent. Before, a core route showed the IP and the user agent of the operator as an act of the member. The compat cancel named the member as the actor. `auth.api.revokeInvitation` takes a new `session` option: the session of the caller, which picks the audit actor only and changes no other step. `auth.api.inviteMember` takes a new `session` option too: a session of an impersonation gets `impersonation_session` with status 403, as `POST /organizations/invite` answers it. `auth.api.createInvitation` of the compat layer passes the session, so it refuses an impersonation with the code `FORBIDDEN` and writes nothing.
