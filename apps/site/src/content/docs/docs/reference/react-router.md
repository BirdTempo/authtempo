---
title: The React Router package
description: The resource route and the server middleware of @authtempo/react-router.
type: reference
sources:
  - packages/react-router/README.md
  - packages/react-router/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
---

**For:** a developer of a React Router 8 app with server middleware.

**What it does:** this page lists the exports of the package, the steps of the mount, and the paths that the `protect` rule gets. The export check holds this page to `packages/react-router/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.
- Node 22.22 or newer. React Router 8.4 needs it (its engines field, read 2026-10-15). The binding adds no floor of its own.

## Steps

1. Mount core: `app/routes/auth.$.ts` holds `export const { loader, action } = authRouteModule(getAuth);`.
2. Read the session: `app/root.tsx` holds `export const middleware = [authMiddleware({ auth: getAuth })];`.
3. Read the session in a loader: `getSession(context)`.
4. Protect paths: `authMiddleware({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authRouteModule` | Answers the `loader` and the `action` of the resource route of core. |
| `authMiddleware` | Answers the middleware that sets the session, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session that the middleware set, or `null`. |
| `sessionContext` | The router context of the session. |
| `AuthSource` | The auth instance, or a function that makes it at the first request. |
| `RouterAuthOptions` | The options of `authMiddleware`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The paths that protect gets

- `protect` gets the path as React Router matched it. ".data" is removed, and each segment is decoded once.
- A decoded "/" stays `%2F`, and "." and ".." are not resolved. So "/%61ccount" reaches the rule as "/account".
- Write a rule in decoded text: "/café", "/σ".
- React Router matches a path without case by default, so "/ACCOUNT" runs the page of "/account".
- React Router ignores trailing slashes on every route that is not a splat, so "/account/" renders "/account".
- So the rule gets more than one form. These are the path as matched, its lower-case form, and both forms with trailing slashes removed.
- The last form is the matched path in the case of the route's own text. For example, "/myaccount" on the route "myAccount" gives "/myAccount".
- A path needs a session when the rule holds for any form. Write a rule in the route's own text.
- Still set `caseSensitive: true` on each protected route, so "/ACCOUNT" gets a 404.
- A parameter value or a splat value keeps the case of the request, because the route has no text for it.
- So a rule on "/en/myAccount" for ":lang/myAccount" misses "/EN/MYACCOUNT". Compare such segments in lower case in the rule.
- A rule must hold for every path that the route matches. Use a prefix rule for a splat or a parameter.
- An exact rule covers one route only. Name each form of an optional segment: ":lang?/account" renders for "/en/account", which a rule on "/account" does not name.
- A data request "/account/...data" reaches a splat route "account/*" as "/account/..", and an exact rule misses it.
- `next` keeps the page URL in URL form, with the case of the request.

## How it behaves

- The package takes `react-router` 8.4.0 or a later 8 release as a peer dependency.
- The middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that the router decodes to a path of core, such as "/%61uth/x", gets a 404 from core, not a page.
- After the sliding refresh, the page's answer carries the renewed session cookie.
- A function given to both `authRouteModule` and `authMiddleware` runs twice for a request to core. Make it return one instance per environment.
- React Router runs the loader of a resource route for an OPTIONS request. So core answers a cross-origin preflight to its routes.

## Next

- [The React package](/docs/reference/react/)
- [The Next.js package](/docs/reference/next/)
