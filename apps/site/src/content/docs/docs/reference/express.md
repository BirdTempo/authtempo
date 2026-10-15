---
title: The Express package
description: The route handler, the session middleware, and the two seams of @authtempo/express.
type: reference
sources:
  - packages/express/README.md
  - packages/express/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of an Express 5 app on Node 22.18 or newer.

**What it does:** this page lists the exports of the package, the steps of the mount, and the paths that the `protect` rule gets. The export check holds this page to `packages/express/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core: `app.use("/auth", authHandler(auth))`.
2. Read the session: `app.use(authSession({ auth }))`, then `getSession(res)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authHandler` | Answers the handler of the routes of core. |
| `authSession` | Answers the middleware that sets `res.locals.session`, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session that the middleware set, or `null`. |
| `toWebRequest` | Answers the web request of an Express request: the full URL, every header, and the body. |
| `sendWebResponse` | Writes a web response to Express, with each `Set-Cookie` line. |
| `AuthSource` | The auth instance, or a function that makes it at the first request. |
| `ExpressSessionOptions` | The options of `authSession`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The paths that protect gets

- `protect` gets the text that the router of Express matched: the raw request path, with its case.
- The path is not decoded, so `%61` stays `%61`. The binding does not resolve "." and "..".
- Express matches without case by default, on the app and on each `express.Router()`. It also matches the hex digits of an escape without case.
- So the binding also runs the rule on the lower-case form of the path, and on that form with each escape in upper-case hex.
- Express routes with strict routing off by default, so `/account` also matches `/account/`. The binding also runs the rule on each form with its trailing slashes removed.
- A path needs a session when the rule holds for any form. Also set `app.set("case sensitive routing", true)`, so `/ACCOUNT` gets a 404.
- An exact rule covers one route only. It does not cover a route with a parameter, such as `/account{/:tab}`.
- For example, `/account/%2F` runs that route with `tab` "/". Use a prefix rule: `p === "/account" || p.startsWith("/account/")`.
- Write a rule for a non-ASCII path in the escaped form, such as `p.startsWith("/caf%C3%A9")`. Node answers 400 to a raw UTF-8 request line before Express runs.

## How it behaves

- The package takes `express` 5.2.1 or a later 5 release as a peer dependency.
- The Express adapter of NestJS 12 pins Express 5.2.1, so the binding runs there too.
- A body parser such as `express.json()` may run before the routes of core. The binding writes the parsed body again in its content type.
- The middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- After the sliding refresh, the answer carries the renewed session cookie.
- The origin of the redirect comes from the protocol and the Host header. A request line in absolute form gives its path only, never the origin.
- A Host header that does not parse gets no 500. The binding uses the origin of `auth.baseURL`, else "http://localhost".
- Behind a TLS proxy, set `app.set("trust proxy", ...)`, so the sign-in redirect keeps https.
- `toWebRequest` and `sendWebResponse` are the two seams to Express.
- This is the one binding package that imports a Node module: `node:stream`.

## Next

- [The Fastify package](/docs/reference/fastify/)
- [The Hono package](/docs/reference/hono/)
