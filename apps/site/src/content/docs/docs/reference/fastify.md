---
title: The Fastify package
description: The route plugin, the session hook, and the two seams of @authtempo/fastify.
type: reference
sources:
  - packages/fastify/README.md
  - packages/fastify/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of a Fastify 5 app on Node 22.18 or newer.

**What it does:** this page lists the exports of the package, the steps of the mount, and the paths that the `protect` rule gets. The export check holds this page to `packages/fastify/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core: `await app.register(authRoutes({ auth }))`.
2. Add the field: `app.decorateRequest("authSession", null)`.
3. Read the session: `app.addHook("onRequest", authSession({ auth }))`, then `getSession(request)` in a route.
4. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authRoutes` | Answers the plugin of the routes of core. In its scope no parser of Fastify runs, so core reads the body as it came. |
| `authSession` | Answers the onRequest hook that sets `request.authSession`, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session that the hook set, or `null`. |
| `toWebRequest` | Answers the web request of a Fastify request of the route plugin. |
| `sendWebResponse` | Writes a web response to Fastify, with each `Set-Cookie` line. |
| `AuthSource` | The auth instance, or a function that makes it at the first request. |
| `FastifyRoutesOptions` | The options of `authRoutes`: `auth`, `basePath`, and `waitUntil`. `waitUntil` keeps work alive after the answer. It has no default. |
| `FastifySessionOptions` | The options of `authSession`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The paths that protect gets

- `protect` gets the path as the router of Fastify matched it, decoded. find-my-way decodes the path once and keeps `%25`.
- So `/%61ccount` reaches the rule as `/account`, and `/caf%C3%A9` as `/café`.
- The path keeps the reserved escapes such as `%2F`, and drops the query. It keeps dot segments and backslashes: `/account/..` stays `/account/..`.
- find-my-way stores a `%` of a route as `%25`. So a route `/x/%2e` is the path `/x/%252e` for the rule.
- The hook reads none of the router options, and fails closed. It runs the rule on each form that the router can match.
- These forms are the path as it is, and the path with duplicate slashes merged (`ignoreDuplicateSlashes`).
- They are also the path with the last slash cut (`ignoreTrailingSlash`), and the path cut at the first `;` (`useSemicolonDelimiter`).
- The hook also folds case: the rule runs on each form in lower case. find-my-way compares with `toLowerCase` when `caseSensitive` is false.
- find-my-way compares the hex digits of a kept escape as text, so `/q%3fx` and `/q%3Fx` reach the same route.
- So the hook also runs the rule with each escape in upper case. The step does not change the text after `%25`, so write that text in lower case.
- Write the rule in lower case, with each kept escape in upper case: `%3F`, `%2F`.
- A path needs a session when the rule holds for one form. Prefer a prefix rule: a route with a parameter or a wildcard also matches paths under the prefix.

## How it behaves

- Node keeps a detached promise alive, so a plain server needs no `waitUntil`. On a host that stops the function after the answer, pass `waitUntil` in the options of `authRoutes`. The SMS of a phone code and the flush of the events run under it (ruling 29 of plan 12i).
- The package takes `fastify` 5.12.5 or a later 5 release as a peer dependency.
- The routes of core read the body as it came. A form post works with no `@fastify/formbody`.
- The plugin passes the raw body stream to core, and Fastify buffers none of it. Core reads at most the cap of each route and answers 413 [`body_too_large`](/docs/reference/errors/#body_too_large) with its own headers. Fastify's `bodyLimit` takes no part in the routes of core.
- The field is `request.authSession`, because `@fastify/session` owns `request.session`.
- The hook reads no session for a route of core. Core reads and renews the session itself.
- The hook skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that Fastify decodes to a path of core, such as `/%61uth/x`, never runs a page.
- When the rule holds for the decoded path and there is no session, the answer is the sign-in redirect. Else core answers 404.
- After the sliding refresh, the answer carries the renewed session cookie.
- Each `Set-Cookie` line of core is added to the answer. A line that an earlier hook set stays.
- The `next` value of the redirect is the path and the query of the request, as a URL reads them.
- One decode by the router gives back the page that the person asked for. So `/account/a%2Fb` returns to `/account/a%2Fb`, and an escaped backslash stays escaped.
- The origin of the redirect comes from the Host header. A request line in absolute form, such as `GET http://host/path`, gives its path only.
- A Host header that does not parse falls back to the origin of core's `baseURL`. So no request gets a 500 of the binding's own.
- `authRoutes` makes its route at registration. With a function in `auth`, the route is under "/auth" unless you set `basePath`.
- With an auth object in `auth`, the route is under the base path of the auth object.
- Behind a TLS proxy, set `trustProxy` in the options of Fastify, so the sign-in redirect keeps https.
- `toWebRequest` and `sendWebResponse` are the two seams to Fastify.

## Next

- [The Express package](/docs/reference/express/)
- [The Hono package](/docs/reference/hono/)
