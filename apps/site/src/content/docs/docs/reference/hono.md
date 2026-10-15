---
title: The Hono package
description: The route handler, the session middleware, and the session read of @authtempo/hono.
type: reference
sources:
  - packages/hono/README.md
  - packages/hono/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of a Hono app on Workers, Node, Bun, or Deno.

**What it does:** this page lists the exports of the package, the steps of the mount, and the path that the `protect` rule gets. The export check holds this page to `packages/hono/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core for every method: `app.all("/auth/*", authHandler(auth))`.
2. Read the session: `app.use("*", authSession({ auth }))`, then `getSession(c)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authHandler` | Answers the handler of the routes of core. |
| `authSession` | Answers the middleware that sets the session, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session that the middleware set, or `null`. |
| `AuthEnv` | The type of the app's variables: `session`. |
| `HonoAuthSource` | The auth instance, or a function of the context that makes it. On Workers the bindings come in `c.env`. |
| `HonoSessionOptions` | The options of `authSession`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The path that protect gets

- `protect` gets the text that Hono matched: `c.req.path`. The gate judges the path as the binding gives it.
- Hono's `getPath` decodes the path once with `decodeURI`, and keeps `%25`.
- The path keeps its case. A trailing slash stays as the `strict` option of Hono leaves it.
- A non-ASCII route reaches the rule decoded, as `/café`. Write the rule for that form, not for `/caf%C3%A9`.
- An exact rule covers one route only. For a route with a wildcard, use `p === "/account" || p.startsWith("/account/")`.

## How it behaves

- The package takes `hono` 4.13.13 or a later 4 release as a peer dependency.
- On Workers, pass a function of the context: `authHandler((c) => getAuth(c.env))`.
- A function given to both `authSession` and `authHandler` runs twice for a request to core. Make it return one instance per environment.
- The middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that Hono decodes to a path of core, such as `/%61uth/x`, never runs a page.
- When the rule holds for the decoded path and there is no session, the answer is the sign-in redirect. Else core answers 404.
- After the sliding refresh, the answer carries the renewed session cookie.
- The redirect takes its origin from the Host header, with the protocol of the request URL. When the Host header is missing or is not one host, the redirect takes the origin of `auth.baseURL`. The origin never comes from the request target.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every server package.

## Next

- [The Express package](/docs/reference/express/)
- [The verify package](/docs/reference/verify/)
