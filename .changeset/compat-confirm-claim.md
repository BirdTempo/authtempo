---
"@authtempo/compat-better-auth": minor
---

A confirm of a password sign-up keeps the password only with core's sign-up proof, the HttpOnly cookie `__Host-tempo_signup` that the sign-up sets. A confirm from another browser deletes the password. The person then sets a first password through `/password/change`.

The verify-email path of the email code plugin passes the request's cookie to core, and its answer gains `passwordKept`.

`api.signUpEmail` answers the proof as `signUpProof`, a member that Better Auth does not have. A server call has no cookie jar, so the app sets the cookie from it. The answer for a taken address holds a proof of the same form. `api.signInEmail` and `api.sendVerificationEmail` read the cookie from `headers`, so a new verify link keeps the proof.

Breaking: an app that signs up on the server and does not set the cookie loses the password at the confirm.
