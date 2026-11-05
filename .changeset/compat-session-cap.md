---
"@authtempo/compat-better-auth": minor
---

Breaking: core's cap of the sessions of one user now holds under the shim. A user holds at most 100 live sessions, and a sign-in past the cap ends the oldest session of the user. Better Auth has no cap. The new setting `authtempo.sessionMaxPerUser` maps to core's `session.maxPerUser` and takes 1 to 1000. Another value is refused at start.
