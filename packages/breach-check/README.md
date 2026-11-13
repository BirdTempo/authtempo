# @authtempo/breach-check

The HIBP Pwned Passwords range API behind core's `password.breachCheck`
(plan 12b). Core names no breach supplier. This package answers the port,
and it has no runtime dependency.

## Install

Run `pnpm add @authtempo/breach-check`.

## Config

```ts
import { createAuth } from "@authtempo/core";
import { createBreachCheck } from "@authtempo/breach-check";

const auth = createAuth({
  // ...
  password: { breachCheck: createBreachCheck() },
});
```

The range API needs no key. HIBP requires a user agent on each request,
and the package sends one.

## Options

| Option | Default | Range | What it does |
| --- | --- | --- | --- |
| `fetch` | the global `fetch` | a fetch function | The fetch of the range call. Tests give a stub. |
| `timeoutMs` | 2000 | an integer from 500 to 10000 | One deadline for the call and the read of its body. |
| `minCount` | 1 | a positive integer | A count of this or more refuses the password. |
| `userAgent` | `authtempo-breach-check` | a string | The `User-Agent` header. The HIBP page requires a user agent. |

A bad `timeoutMs` or `minCount` throws when you call `createBreachCheck`.

## Answers

- **`true`:** the range answer holds the suffix with a count of `minCount` or more. Core refuses the password with 400 `password_breached`.
- **`false`:** the range answer does not hold the suffix, or holds it with a lower count.
- **`"unavailable"`:** no answer before the deadline, a network error, a status other than 200, a body over 512 KB, or a 200 body with no `SUFFIX:COUNT` line. A 3xx status is in this list: the call follows no redirect.

## The check fails closed

Core refuses the password on `"unavailable"` with 503
[`breach_check_unavailable`](https://authtempo.com/docs/reference/errors/#breach_check_unavailable).
The person tries again later. There is no bundled list of breached
passwords. A reset link stays usable after the refusal. A reset code is
spent, so the person asks for a new code.

Each log line holds the cause only. No log line holds the password, the
hash, or the prefix.

## How the call works

1. The package computes the SHA-1 of the UTF-8 password, in uppercase hex.
2. It sends `GET https://api.pwnedpasswords.com/range/<first 5 characters>`.
3. It reads the answer: one `SUFFIX:COUNT` on each line.
4. It compares each suffix with the rest of the hash, with no regard to case.

Only the first 5 characters of the hash leave the process (k-anonymity).
The call sends `Add-Padding: true`. The HIBP page says that padding adds
800 to 1,000 records. A padded line has a count of 0, so it never refuses a
password. A whole range is larger: on 2026-10-15, eight padded ranges held
76 to 105 KB, about 2,000 lines each. The cap of 512 KB holds about five
times the largest of them. A 200 body with no `SUFFIX:COUNT` line, such as
an empty body or the HTML page of a proxy, answers `"unavailable"`.

The HIBP page states no rate limit for the range API. Core runs a limit
before each check, so the limits of core bound the range calls.

## Sources

The facts come from the HIBP API v3 page, section "Pwned Passwords", read
on 2026-10-14: the range URL, the 5-character prefix, `Add-Padding`, the
count of 0 on a padded line, no key, and the user agent rule.

## Tests

The unit tests send no network call: each range call goes to a fetch stub.
`test/live.test.ts` calls the real range API. It runs only when
`AUTHTEMPO_LIVE_HIBP=1` is set. A skipped live test is not evidence that the
range API works.
