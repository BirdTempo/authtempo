---
"@authtempo/core": minor
---

The confirm of a password sign-up keeps the sign-up's password only in the browser or the app of the sign-up. Any other confirm is a claim.

A sign-up now gives a sign-up proof: `sp_` and 32 random bytes. Each answer holds it as `signUpProof`, and the route sets it as the HttpOnly cookie `__Host-tempo_signup`. The cookie lives as long as the link or the code. A known address gets a proof too, so the answer tells no account. The verify row holds the SHA-256 of the proof, so no query moves.

A confirm by link or by code that carries the proof keeps the password. The cookie wins over the `signUpProof` member of the code form. Any other confirm deletes that password, and the person who opened the link gets a proved session. The JSON answers of `POST /password/verify` and `POST /password/verify/code` gain `passwordKept`. The redirect of the link goes to `/?password=set` when the password went. The person then sets a first password through `POST /password/change` with no current password. The confirm clears the cookie.

`PasswordSignUpResult` gains `signUpProof`. `PasswordVerified` gains `passwordKept`. `PasswordVerify`, `PasswordVerifyCode`, `PasswordResend`, and `PasswordSignInFields` take `signUpProof`. The body of `POST /password/sign-in`, of `POST /password/verify/code`, and of `POST /password/verify/resend` takes `signUpProof` too.

A resend copies the proof hash to the new row only when the request carries the proof of an earlier row of the same sign-up. A password sign-in that mails a new link or code does the same. Each reads the cookie, else the body member. The resend answer sets the cookie again for the life of the new link or code.

The root entry exports `SIGN_UP_PROOF_COOKIE`. The compat entry exports `newSignUpProof`. `CORE_PREFIXES` gains `sp_`. A config with `cookieName` or `lastMethod.cookieName` set to `__Host-tempo_signup` now fails at start.

Breaking: an app whose sign-up opens the link outside its own browser loses the sign-up's password at the confirm. A native app whose link opens in the system browser is one. An app on another site than the auth origin is one too, because many browsers drop its third-party proof cookie. Such an app uses `password.verifyBy: "code"` and sends `signUpProof` with the code. Else it shows a first-password form after the confirm.

Breaking: an in-process call of `api.password.verifyEmail` or `verifyCode` with no `signUpProof` deletes the sign-up's password. Pass the `signUpProof` of the sign-up's answer.
