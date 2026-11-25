---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": patch
---

The new config block `limits` changes two rules of the rate limits. Without it, each limit works as before.

`limits.windows` gives a limit family another window, such as `"otp:email": { max: 5 }`. `max` is from 1 to 100000, and `seconds` is from 1 to 86400. Core refuses an unknown family at the start. It also refuses the six families whose window comes from another setting. A higher `max` lets a caller try more.

`limits.noClientIp: "refuse"` ends the shared count of the requests with no client IP. `handle` answers 403 `client_ip_missing` to such a request before any route. An in-process call of `auth.api` with `ip: null` throws at its first per-IP limit.

The client has a text for the new code `client_ip_missing`. The compat error map names it.
