# @authtempo/captcha-turnstile

Cloudflare Turnstile behind core's `captcha.port` (plan 12b). Core names no
captcha supplier. This package answers the port, and it has no runtime
dependency.

## Install

When the package is published, run `pnpm add @authtempo/captcha-turnstile`.
Publication is on hold. In this workspace, add it with `"workspace:*"`.

## Config

```ts
import { createAuth } from "@authtempo/core";
import { createTurnstileCaptcha } from "@authtempo/captcha-turnstile";

const auth = createAuth({
  // ...
  captcha: {
    port: createTurnstileCaptcha({
      secretKey: env.TURNSTILE_SECRET_KEY,
      siteKey: "<site key>",
    }),
  },
});
```

Keep the secret key in a Worker secret. Do not put it in the source or in
`wrangler.jsonc`. With `siteKey`, core's sign-in page shows the widget. Without
it, your own page shows the widget and sends its token in the header
`x-captcha-response`.

## Options

| Option | Default | Range | What it does |
| --- | --- | --- | --- |
| `secretKey` | none | a non-empty string | The widget's secret key. No log line holds it. |
| `siteKey` | none | 1 to 128 letters, digits, `_`, or `-` | With it, core's sign-in page shows the widget. |
| `fetch` | the global `fetch` | a fetch function | The fetch of the siteverify call. Tests give a stub. |
| `timeoutMs` | 3000 | an integer from 500 to 10000 | One deadline for the call and its retry. |
| `expectedAction` | none | a string | A token with another `action` fails. |
| `allowedHostnames` | none | a list of hostnames | A token from another hostname fails. |

## Answers

- **`pass`:** siteverify answered `success: true`, and the action and the hostname match the options.
- **`fail`:** siteverify answered `success: false`, or the action or the hostname do not match.
- **`fail` with no call:** the token is longer than 2048 characters.
- **`unavailable`:** no answer before the deadline, a network error, a status other than 200, or a body that is not JSON.

A token passes once. A second check of the same token answers `fail`
(`timeout-or-duplicate`). A wrong secret key answers `fail` for every token,
and the log line names the cause.

Core decides what `unavailable` does. With `captcha.onUnavailable: "allow"`
(the default), the flow goes on, and core writes one log line. With
`"refuse"`, core answers 503 `captcha_unavailable`.

## Retry

The port sends one call. It sends one retry after a network error, after a
status other than 200, and after the code `internal-error`. The retry has the
same `idempotency_key`, so siteverify does not count the token two times. The
port follows no redirect: a 3xx answer is no answer.

## Sources

The facts come from these Cloudflare pages, read on 2026-10-14:

- "Validate the token", last updated 2026-09-16: the siteverify URL, the JSON body, the 2048-character limit, the idempotency key, and the error codes.
- "Embed the widget", last updated 2026-06-17: the script URL, the widget markup, and the field `cf-turnstile-response`.
- "Content Security Policy", last updated 2026-05-05: `https://challenges.cloudflare.com` in `script-src` and `frame-src`.
- "Stop account takeover attacks", read 2026-10-15: the always-pass secret key below. It links to "Test your Turnstile implementation" for the full list.

The value of the dummy token is from plan 12b. It was not read again on
2026-10-15. If the live test fails, check the token first.

## Test keys

Use these keys in tests only. They never protect a real site.

| Key | Value |
| --- | --- |
| The always-pass secret key | `1x0000000000000000000000000000000AA` |
| The dummy token that this secret accepts | `XXXX.DUMMY.TOKEN.XXXX` |

## Tests

The unit tests send no network call: each siteverify call goes to a fetch
stub. `test/live.test.ts` calls the real siteverify with the test secret. It
runs only when `AUTHTEMPO_LIVE_TURNSTILE=1` is set. A skipped live test is not
evidence that siteverify works.
