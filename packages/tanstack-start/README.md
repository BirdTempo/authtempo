# @authtempo/tanstack-start

The TanStack Start binding of authtempo, for React Start and Solid Start of
TanStack. It imports nothing of TanStack, so one package serves both, and it
names no peer dependency. Its typings fixture compiles against
`@tanstack/react-start` 1.169.1 and `@tanstack/solid-start` 1.169.1.
The Solid fit is checked at the type level only: `@tanstack/solid-router`
does not load in vitest on Node, and the example app is React.

1. Mount core: `src/routes/auth.$.ts` holds
   `export const Route = createFileRoute("/auth/$")({ server: { handlers: authRouteHandlers(getAuth) } });`.
2. Read the session: `src/start.ts` adds
   `createMiddleware({ type: "request" }).server(authRequestServer({ auth: getAuth }))`
   to `requestMiddleware`, and a handler reads `getSession(context)`.
3. Protect paths: `authRequestServer({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- `createMiddleware` comes from `@tanstack/react-start` or `@tanstack/solid-start`.
- `protect` gets the path that the router of TanStack matches, not the raw
  path of the request. The router decodes the path once: "/%61ccount"
  reaches the rule as "/account", and "/caf%C3%A9" as "/café". "%25" and
  "%5C" stay escaped. The URL parser has already resolved "." and ".."
  segments and read "\" as "/". The router removes each "/" at the end, so
  "/account/" reaches the rule as "/account". "/account/.." reaches it as
  "/", the path that the router matches.
- The router matches a path without case by default, so "/ACCOUNT" runs the
  page of "/account". The binding cannot read the router's case option, so it
  folds case for `protect`: a path needs a session when the rule holds for the
  path or for its lower-case form.
- `next` holds the page URL that TanStack gives the middleware, with the
  query, not the decoded path: "/%61ccount" gives `next=%2Faccount`, and
  "/%2561ccount" keeps its escape. `next` keeps the case of the request and a
  "/" at the end.
- The middleware reads no session for a route of core, and adds the renewed
  cookie to the page's answer after the sliding refresh. Every Set-Cookie
  line of core passes unchanged.
- A server function runs at its own path, so a `protect` rule for a page does
  not cover the server functions that the page calls. Read
  `getSession(context)` in each server function that needs a session.
- The server reads the session from the middleware's context. A server render
  never subscribes to the session store of `@authtempo/client`.
- A function given to both `authRouteHandlers` and `authRequestServer` runs
  twice for a request to core, so make it return one instance per process.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every
  server binding.
