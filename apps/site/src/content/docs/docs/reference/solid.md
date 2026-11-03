---
title: The Solid package
description: The provider and the primitives of @authtempo/solid, and the server of Solid Start in @authtempo/solid/start.
type: reference
sources:
  - packages/solid/README.md
  - packages/solid/src/index.ts
  - packages/solid/src/start.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of a Solid app, or of a Solid Start app.

**What it does:** this page lists the exports of the two entries, and the paths that the `protect` rule gets. The export checks hold this page to `packages/solid/src/index.ts` and `packages/solid/src/start.ts`.

## Before you start

- Read [The client package](/docs/reference/client/) for the session store under the primitives.

## Steps

In the browser:

1. Put `AuthProvider` with one client at the root of the app.
2. Read the session: `const { session } = useSession()`, then `session().data`.
3. Show the failure of a provider sign-in: `useAuthError()` reads `?auth_error=` once.

On the server of Solid Start:

1. Mount core: `src/routes/auth/[...path].ts` holds `const h = authRouteHandlers(getAuth)`.
2. Export one handler per method by name, such as `export const GET = h.GET;`.
3. Read the session: `src/middleware.ts` holds `export default createMiddleware({ onRequest: [authOnRequest({ auth: getAuth })] });`.
4. Read the session in an API route with `getSession(event)`.
5. Read the session in server code of a page with `getSession(getRequestEvent())`, not with `useSession`.
6. Protect paths: `authOnRequest({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.
7. On Workers, keep `authRouteHandlers(getAuth)`. The handlers pass the `waitUntil` of the request of srvx to `handle` themselves.

## Exports

### The browser entry

| Export | What it does |
| --- | --- |
| `AuthProvider` | Gives a client to every primitive below it. |
| `useSession` | Answers a `UseSession`: `session`, an accessor of `{ data, error, isPending, isRefetching }`, and `refetch`. |
| `useClient` | Answers the client of the nearest provider. It throws when there is none. |
| `useAuthError` | Answers the code of `?auth_error=` in the URL, read once, or `null`. |
| `AuthErrorCode` | The type of the code that `useAuthError` answers: the answer of `client.readRedirectError`. |
| `UseSession` | The type that `useSession` answers. |

### The Solid Start entry

`@authtempo/solid/start` is for the server of Solid Start 2.

| Export | What it does |
| --- | --- |
| `authRouteHandlers` | Answers the `GET`, `POST`, and `OPTIONS` of `src/routes/auth/[...path].ts`. Export each method by name. |
| `authOnRequest` | Answers the `onRequest` that sets `locals.session`. It sends a person with no session on a protected path to the sign-in page. It writes the renewed cookie to the response headers of the event. |
| `getSession` | Answers the session that the middleware set, or `null`. |
| `AuthSource` | The auth instance, or a function that makes it at the first request. |
| `StartEventLike` | The fields of the event that the entry reads. |
| `StartApiEventLike` | The fields of the API event that the handlers read: `request`, and `nativeEvent.req` for the hook of the runtime. |
| `StartRouteOptions` | The options of `authRouteHandlers`: `waitUntil`, the hook that keeps work alive after the answer. Default: the `waitUntil` of the request of srvx. |
| `SolidStartAuthOptions` | The options of `authOnRequest`: `auth`, `protect`, `signInPath`, and `basePath`. |

## In the browser

- The package takes `solid-js` 1.9.17 or a later 1 release as a peer dependency. The Solid Start entry takes `@solidjs/start` 2.0.6 or a later 2 release as an optional peer.
- The subscription of `useSession` ends with the owner of the component.
- A server render shows the pending state. It never subscribes to the client store, and starts no read.
- A test in a DOM needs the browser build of `solid-js`. Set the `browser` condition and inline `solid-js` in the vitest config.

## The paths that protect gets

- `protect` gets the path as the routers of Solid Start 2.0.6 match it. That is the path of `request.url` after the URL parse, with one `/` at the end removed.
- The parse resolves `..`, `%2e`, a backslash, and a tab. No escape is decoded.
- So `/%61ccount` reaches the rule as `/%61ccount`, and no route `/account` matches it.
- Write a non-ASCII path encoded, with escapes in upper case: `p === "/caf%C3%A9"`.
- Solid Router lower-cases a page path and its pattern, hex included. So `/caf%c3%a9` and `/CAF%C3%A9` run the page `/café`.
- An API route matches with case (radix3 1.1.2). `/MYACCOUNT` runs no route `/myAccount`, and answers 404.
- A page matches without case: Solid Router 1.0.0 compares each static part in lower case. So `/ACCOUNT` runs the page `/account`.
- Both routers remove one `/` at the end, so `/account/` runs the route `/account`. radix3 runs a child route `/account/:id` for `/account//`, with an empty id.
- So the entry asks `protect` with the path as matched, and with each `/` at the end removed. The path `/` stays `/`.
- It also asks with both forms in lower case, and with the lower-case forms with each escape in upper case.
- A path needs a session when the rule holds for any form. A rule `p === "/account"` protects `/ACCOUNT`, `/account/`, `/account//`, and `/ACCOUNT/`.
- Warning: a rule with an upper-case letter does not protect a page in another case.
- `p.startsWith("/myAccount")` holds for neither `/MYACCOUNT` nor `/myaccount`, and Solid Router runs the page `/myAccount` for both.
- For a page, write the rule in lower case: `protect: (p) => p.toLowerCase().startsWith("/myaccount")`.
- The rule gets the full path. Under a `server.baseURL`, write the rule with that base.

## On the server of Solid Start

- A person with no session on a protected path gets a 307 to the sign-in page, and no route runs.
- A server function runs at `/_server`, so a `protect` rule for a page does not cover the server functions that the page calls.
- Read `getSession(getRequestEvent())` in each server function that needs a session.
- The middleware writes the renewed cookie to the response headers of the event.
- The handlers of core give `handle` the `waitUntil` of `event.nativeEvent.req`, the request of srvx. srvx sets it on Workers. The SMS of a phone code and the flush of the events run under it after the answer (ruling 29 of plan 12i).
- Solid Start 2.0.6 (h3 2.0.2) puts those headers on the answer of a page, and on the answer of an API route below status 400.
- The origin of the redirect comes from the Host header, else from the origin of `auth.baseURL`. A request line in absolute form never sets it.
- The middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.

## Next

- [The Vue package](/docs/reference/vue/)
- [The TanStack Start package](/docs/reference/tanstack-start/)
