---
"@authtempo/client": minor
---

The types of the password calls follow core's sign-up proof. Each `password.signUp` answer holds `signUpProof`. `password.verifyEmail` and `password.verifyCode` answer `passwordKept`. `password.verifyCode`, `password.resendVerification`, and `password.signIn` take `signUpProof`. A native app passes the proof of its sign-up, or the confirm deletes the password. So a native app confirms by `verifyCode`. A `verifyEmail` call reads no proof and answers no token, so the app keeps no session and no password.
