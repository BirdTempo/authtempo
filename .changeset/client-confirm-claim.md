---
"@authtempo/client": minor
---

The types of the password calls follow core's sign-up proof. Each `password.signUp` answer holds `signUpProof`. `password.verifyEmail` and `password.verifyCode` answer `passwordKept`. `password.verifyCode`, `password.resendVerification`, and `password.signIn` take `signUpProof`. A native app passes the proof of its sign-up, or the confirm deletes the password.
