---
title: The TanStack Start package
description: The server handlers and the request middleware of @authtempo/tanstack-start, for React and for Solid.
type: reference
sources:
  - packages/tanstack-start/README.md
  - packages/tanstack-start/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of a TanStack Start app with React or with Solid.

**What it does:** this page lists the exports of the package, the steps of the mount, and the paths that the `protect` rule gets. The export check holds this page to `packages/tanstack-start/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core: `src/routes/auth.$.ts` holds `export const Route = createFileRoute("/auth/$")({ server: { handlers: authRouteHandlers(getAuth) } });`.
2. Read the session: `src/start.ts` adds `createMiddleware({ type: "request" }).server(authRequestServer({ auth: getAuth }))` to `requestMiddleware`.
3. Read the session in a handler: `getSession(context)`.
4. Protect paths: `authRequestServer({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authRouteHandlers` | Answers the `GET`, `POST`, and `OPTIONS` handlers of the splat route of core. |
| `authRequestServer` | Answers the server function of a request middleware: it gives `{ session }` to the context, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session of a context, or `null`. |
| `AuthSource` | The auth instance, or a function that makes it at the first request. |
| `RouteHandler` | The type of one server handler. |
| `RequestServer` | The type that `authRequestServer` answers. |
| `SessionContext` | The context that the middleware gives: `session`. |
| `StartAuthOptions` | The options of `authRequestServer`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The paths that protect gets

- `protect` gets the path that the router of TanStack matches, not the raw path of the request.
- The router decodes the path once. So "/%61ccount" reaches the rule as "/account", and "/caf%C3%A9" as "/café". "%25" and "%5C" stay escaped.
- The URL parser has already resolved "." and ".." segments and read "\\" as "/".
- The router removes each "/" at the end. So "/account/" reaches the rule as "/account", and "/account/.." reaches it as "/".
- The router matches a path without case: it compares the lower-case form of the route with the lower-case form of the path.
- So "/ACCOUNT" runs the page of "/account". The binding cannot read a case option, so it runs `protect` on three forms.
- These forms are the path, its lower-case form, and the lower-case form with each escape in upper-case hex ("/q%3Fx").
- A path needs a session when the rule holds for one form. The router keeps an escape such as "%3F" in the hex case of the request.
- Write the rule in lower case, with each escape in upper case. Then it holds for every case of the path.
- Warning: a rule with a capital letter misses a page in another case. `p.startsWith("/myAccount")` misses "/myaccount" and "/MYACCOUNT", which run the page with no session.

## How it behaves

- The package names no peer dependency, because it imports nothing of TanStack.
- `createMiddleware` comes from `@tanstack/react-start` or `@tanstack/solid-start`.
- A typings fixture compiles the binding against `@tanstack/react-start` 1.169.1 and `@tanstack/solid-start` 1.169.1.
- A test runs the real request middleware of `@tanstack/solid-start` in vitest, under three settings.
- These settings are happy-dom, the browser build of `solid-js`, and an inline transform of `solid-js` and `@tanstack`. The example app is React.
- The middleware reads no session for a route of core. Core reads and renews the session itself, and every `Set-Cookie` line of core passes unchanged.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that the router decodes to a path of core, such as "/%61uth/x", never runs a page.
- When the rule holds for the decoded path and there is no session, the answer is the sign-in redirect. Else core answers 404.
- After the sliding refresh, the page's answer carries the renewed session cookie.
- The origin of the redirect comes from the Host header, with the protocol of the request, not from the request line.
- The Node server of TanStack Start builds the URL of an absolute-form line, such as "GET http://evil.example/account", from that line. The binding does not use it.
- A missing Host header, or a Host that does not parse as one host, falls back to the origin of core's `baseURL`.
- So does a request URL that is not http or https.
- Behind a proxy, send the public Host to the app. The binding never reads X-Forwarded-Host, even when srvx trusts it.
- `next` holds the page URL that TanStack gives the middleware, with the query, not the decoded path.
- So "/%61ccount" gives `next=%2Faccount`, and "/%2561ccount" keeps its escape. `next` keeps the case of the request and a "/" at the end.
- A server function runs at its own path, so a `protect` rule for a page does not cover the server functions that the page calls.
- Read `getSession(context)` in each server function that needs a session.
- The server reads the session from the context of the middleware. A server render never subscribes to the session store of `@authtempo/client`.
- A function given to both `authRouteHandlers` and `authRequestServer` runs twice for a request to core. Make it return one instance per process.

## Next

- [The React package](/docs/reference/react/)
- [The Solid package](/docs/reference/solid/)
