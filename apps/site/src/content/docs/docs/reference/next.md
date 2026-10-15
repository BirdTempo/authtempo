---
title: The Next.js package
description: The route handlers, the session read, and the proxy of @authtempo/next.
type: reference
sources:
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
- Next 16 renamed middleware to proxy. The file is `proxy.ts`, and its export is `proxy`.
- Without `auth`, the proxy checks only that the session cookie is present. With `auth`, it asks core: one storage read per protected request.
- The default `cookieName` is `__Host-tempo_session`. With the default, the proxy also reads the cookie name of before plan 12b, as core does.
- A server component cannot set a cookie. The browser gets a renewed cookie at its next call to a route under `/auth`.
- It takes `next` 16.4 or a later 16 release as a peer dependency.

## Next

- [Mount authtempo in Next.js](/docs/guides/next/)
- [The React package](/docs/reference/react/)
