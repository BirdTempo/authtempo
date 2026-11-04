---
"@authtempo/core": minor
---

A session now holds a proof flag, `proved`, that core sets once at its creation. It is true when the user has a verified address. For a user with no address, it is true when the sign-in proved a handle: a phone code or a passkey. A handoff copies the flag of its browser session, and an impersonation takes the state of its target. A `session.beforeCreate` hook cannot set it.

Every verified-only action reads the flag of the caller's session with the user's flag. So a session made before the proof of its address never gains verified powers. A claimant's session acts as unverified between the claim's flip and its session delete. It makes no token, no address change, no grant, and no factor there. A caller with no session, such as a `tk_` token, keeps the rule of the user row.

Breaking: `api.tokens.create`, `api.passkeyRegistrationOptions`, `api.verifyPasskeyRegistration`, `api.totp.setup`, and `api.organizationTokens.create` take `session` in place of `user` or `userId`. Pass the answer of `api.getSession` or `auth.session`. A call with `user` or `userId` fails the type check. The input types `ApiTokenCreate`, `TotpSetupInput`, and `OrganizationTokenCreate` changed the same way.

Each route passes the session it holds to the other verified-only checks. They are the token list, revoke, and update, and the organization, team, invitation, slug, and organization token calls. An in-process call with `user` only keeps the rule of the user row.

A claim now deletes the identities, the passwords, the passkeys, the passkey challenges, and the handoff codes before the sessions. The passkey sign-in and the handoff redeem end with a conditional update of the row that they trust, on every path. When a claim took that row, the sign-in deletes its own session and answers its failure. The password sign-in and the social sign-in already did so.

The `email_verified` claim of a session JWT reads the session flag with the user's flag. `publicUser`, the ID token, and userinfo keep the user's flag. The confirm of a change of address sets the flag on the session that it keeps.

A password sign-in of a user with no address gets the flag when that user holds a verified handle. That handle is a phone that signs in, or a passkey. So a phone user's password session holds the verified powers, and a username-only user's does not.

The compat entry of core exports `createApiTokenAs` and `createOrganizationTokenAs` for a server call that names its user and has no session. They keep the rule of the user row.
