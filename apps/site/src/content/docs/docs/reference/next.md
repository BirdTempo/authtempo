---
title: The Next.js package
description: The route handlers, the session read, and the proxy of @authtempo/next.
type: reference
sources:
  - packages/next/README.md
  - packages/next/src/index.ts
  - examples/next/proxy.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 20
  - docs/superpowers/plans/2026-10-14-11d-sdks.md
---

**For:** a developer of a Next.js app on the App Router.

**What it does:** this page lists the exports of the package. The export check holds this page to `packages/next/src/index.ts`.

## Before you start

- Read [Mount authtempo in Next.js](/docs/guides/next/) for the steps.

## Exports

| Export | What it does |
| --- | --- |
| `authRouteHandlers` | Answers `{ GET, POST, OPTIONS }` for `app/auth/[...path]/route.ts`. |
| `authSession` | Answers the session of a server component from its headers, or `null`. It renews no cookie. |
| `authProxy` | Answers the `proxy` of `proxy.ts`. A request on a protected path with no session goes to the sign-in page with `next`. |
| `AuthProxyOptions` | The options of `authProxy`: `protect`, `signInPath`, `auth`, and `cookieName`. |
| `AuthSource` | An auth instance, or a function that makes it at the first request. |

## How it behaves

- The package imports nothing of Next at run time. It takes a web request and answers a web response.
- Next 16 renamed middleware to proxy. The file is `proxy.ts`, and its export is `proxy`. A file named `middleware.ts` gets a deprecation warning from Next.
- Without `auth`, the proxy checks only that a session cookie is present, or a bearer that starts with `ts_` (`SESSION_TOKEN_PREFIX`). It does not check that the session is live. Never trust the proxy alone.
- With `auth`, the proxy asks core, with no write: one storage read per protected request.
- The default `cookieName` is `__Host-tempo_session`. With the default, the proxy also reads the cookie name of before plan 12b, as core does.
- `authSession` is a read with no write. A server component cannot set a cookie, so the read leaves the sliding refresh for the browser.
- The browser gets the renewed cookie from its own read of `GET /auth/session`, such as the read of the session store of `@authtempo/react`. Other routes under `/auth` do not renew it.
- An app with no such read calls `/auth/session` from the page. Otherwise the cookie ends at its first `Max-Age`.
- It takes `next` 16.4 or a later 16 release as a peer dependency.

## Next

- [Mount authtempo in Next.js](/docs/guides/next/)
- [The React package](/docs/reference/react/)
