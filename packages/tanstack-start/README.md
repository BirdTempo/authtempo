# @authtempo/tanstack-start

The TanStack Start binding of authtempo, for React Start and Solid Start of
TanStack. It imports nothing of TanStack, so one package serves both, and it
names no peer dependency. Its typings fixture compiles against
`@tanstack/react-start` 1.169.1 and `@tanstack/solid-start` 1.169.1.
A test also runs the real request middleware of `@tanstack/solid-start` in
vitest, with happy-dom, the browser build of solid-js, and an inline
transform of solid-js and `@tanstack`. The example app is React.

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
- The router matches a path without case: it compares the lower-case form of
  the route with the lower-case form of the path (router-core 1.171.37). So
  "/ACCOUNT" runs the page of "/account". The binding cannot read a case
  option, so it runs `protect` on the path and on its lower-case form: a path
  needs a session when either holds. Write the rule in lower case, and it
  holds for every case of the path. A rule with a capital letter, such as
  `p.startsWith("/myAccount")`, misses "/myaccount" and "/MYACCOUNT", which
  run the page of "/myAccount" with no session.
- The origin of the redirect comes from the Host header, with the protocol of
  the request, not from the request line: the Node server of TanStack Start
  builds the URL of an absolute-form line ("GET http://evil.example/account")
  from that line. A Host that does not parse falls back to the origin of
  core's `baseURL`.
- Behind a proxy, send the public Host to the app: the binding never reads
  X-Forwarded-Host, even when srvx trusts it. `auth.baseURL` serves only
  when Host does not parse.
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
