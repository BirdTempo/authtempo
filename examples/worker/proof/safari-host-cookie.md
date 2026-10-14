# The `__Host-` cookie in Safari on localhost (plan 12b, owner-run)

Core sets the session cookie `__Host-tempo_session` with `Secure`. A
browser may refuse a `Secure` cookie from `http://localhost`. No test runs
Safari, so the owner runs these steps once and records the result.

## Steps

1. Run `cd examples/worker`.
2. Apply the migrations to the local D1. `CI=1` skips the confirm prompt:

   ```sh
   CI=1 pnpm exec wrangler d1 migrations apply DB --local
   ```

3. Start the Worker on `http://localhost:8787`, with test mode on and a new secret:

   ```sh
   pnpm exec wrangler dev --var BASE_URL:http://localhost:8787 --var TEST_MODE:1 --var AUTH_SECRET:$(openssl rand -hex 32)
   ```

   Without `BASE_URL`, the mail link points to `https://example.test`. Without `TEST_MODE`, step 5 answers 404.

4. In a second terminal, ask for a magic link:

   ```sh
   curl -s -X POST http://localhost:8787/auth/magic-link/request -H 'content-type: application/json' -d '{"email":"safari@example.com"}'
   ```

5. Read the link: `curl -s http://localhost:8787/__test/last-link`.
6. Open the link in Safari. Press the button of the confirm page.
7. In the Web Inspector, open Storage, then Cookies, then `localhost`. Check that `__Host-tempo_session` is set.
8. In the same tab, open `http://localhost:8787/auth/session`. Check that it answers the user as JSON.
9. Stop the Worker with Ctrl-C.

Expected: the cookie is set, and the session answers.

## If Safari refuses the cookie

Add this sentence to `apps/site/src/content/docs/docs/reference/cookies.md`:
"Safari keeps no `Secure` cookie from `http://localhost`. On Safari, run
development over https, and set the base URL to the https origin."

To check that fallback, repeat the steps with https. Use `https://` in
steps 4, 5, and 8:

```sh
pnpm exec wrangler dev --local-protocol https --var BASE_URL:https://localhost:8787 --var TEST_MODE:1 --var AUTH_SECRET:$(openssl rand -hex 32)
```

Add `-k` to the two curl calls of steps 4 and 5. curl refuses the
self-signed certificate without it:

```sh
curl -sk -X POST https://localhost:8787/auth/magic-link/request -H 'content-type: application/json' -d '{"email":"safari@example.com"}'
curl -sk https://localhost:8787/__test/last-link
```

The base URL must be the https origin. With an http base URL, the mail link
is http, and the https origin is not trusted. The confirm post then answers
403. wrangler serves a self-signed certificate. Make Safari trust it before
step 6, or Safari does not open the page.

A `cookieName` with no prefix does not help. Core sets `Secure` on every
cookie, whatever its name.

## The record

| Field | Value |
| --- | --- |
| Date of the run | `<to fill>` |
| Safari version | `<to fill>` |
| macOS version | `<to fill>` |
| `__Host-tempo_session` set (step 7) | `<to fill: yes or no>` |
| `/auth/session` answer (step 8) | `<to fill: status>` |

The controller writes this result into the evidence line of plan 12b
Task 14 in the plan index.
