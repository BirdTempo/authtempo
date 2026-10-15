# @authtempo/hono

The Hono binding of authtempo. It runs where Hono runs: Workers, Node, Bun,
and Deno. It takes `hono` 4.13.13 or newer in 4 as a peer dependency.

1. Mount core for every method: `app.all("/auth/*", authHandler(auth))`.
2. Read the session: `app.use("*", authSession({ auth }))`, then `getSession(c)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- On Workers, pass a function of the context: `authHandler((c) => getAuth(c.env))`.
  A function given to both `authSession` and `authHandler` runs twice for a
  request to core, so make it return one instance per environment.
- `authSession` reads no session for a route of core, and adds the renewed
  cookie to the answer after the sliding refresh.
- `protect` gets the path exactly as Hono matched it, `c.req.path`: decoded
  once by Hono's `getPath` (`decodeURI`, with `%25` kept), with its case kept,
  and with a trailing slash as the `strict` option of Hono leaves it. A
  non-ASCII route reaches the rule decoded, as `/café`. Write the rule for
  that form, not for `/caf%C3%A9`. The gate of `@authtempo/core/bindings`
  judges the path as the binding gives it.
  An exact rule covers one route only. For a route with a wildcard, use
  `p === "/account" || p.startsWith("/account/")`.
- Mount core for every method. With fewer methods, a PUT to `/auth/x` skips
  the gate and reaches a catch-all page of the app with no session.
- The redirect to the sign-in page takes its origin from the request URL, as
  the server builds it. Bun 1.4.3 builds it from the Host header.
  `@hono/node-server` 1.19.17 and 2.1.5 build it from the Host header, but
  take an absolute-form request line, such as `GET http://other.example/x`, as
  given. The redirect then names that origin. Check the rule of your server
  on Deno and on Workers.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every
  server binding.
