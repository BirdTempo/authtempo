---
"@authtempo/core": minor
---

A session now holds a proof flag, `proved`, that core sets once at its creation. Only the confirm of a change of address changes it later, to true on the session it keeps. It is false for an anonymous user. For a user with an address, it is the verified flag of that address. For any other user, it is true, because a user with no address has nothing to claim. A handoff copies the flag of its browser session, and an impersonation takes the state of its target. A `session.beforeCreate` hook cannot set it.

Every verified-only action reads the flag of the caller's session with the user's flag. So a session made before the proof of its address never gains verified powers. A claimant's session acts as unverified between the claim's flip and its session delete. It makes no token, no address change, no grant, and no factor there. A caller with no session, such as a `tk_` token, keeps the rule of the user row.

Breaking: `api.tokens.create`, `api.passkeyRegistrationOptions`, `api.verifyPasskeyRegistration`, `api.totp.setup`, and `api.organizationTokens.create` take `session` in place of `user` or `userId`. Pass the answer of `api.getSession` or `auth.session`. A call with `user` or `userId` fails the type check. The input types `ApiTokenCreate`, `TotpSetupInput`, and `OrganizationTokenCreate` changed the same way. The root entry now exports `PasskeyRegistrationOptionsInput` and `PasskeyRegistrationInput`, the input types of the two passkey forms.

Each route passes the session it holds to the other verified-only checks. They are the token list, revoke, and update, and the organization, team, invitation, slug, and organization token calls. Except `api.tokens.update` and `api.organizationTokens.update`, the app API forms of these closed flows take no session. So an in-process call there keeps the rule of the user row.

A claim now deletes the identities, the passwords, the passkeys, the passkey challenges, and the handoff codes before the sessions. The passkey sign-in and the handoff redeem end with a conditional update of the row that they trust, on every path. When a claim took that row, the sign-in deletes its own session and answers its failure. The password sign-in and the social sign-in already did so.

The `email_verified` claim of a session JWT reads the session flag with the user's flag. `publicUser`, the ID token, and userinfo keep the user's flag. The confirm of a change of address sets the flag on the session that it keeps.

A user with no address that is not anonymous gets the flag at every sign-in, the password sign-in too. Each verified-only action still reads the user row. So a username-only user can change its password, and it makes no API token, because it holds no verified handle.

The compat entry of core exports `createApiTokenAs` and `createOrganizationTokenAs` for a server call that names its user and has no session. They keep the rule of the user row.
