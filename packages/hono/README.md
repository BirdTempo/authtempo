# @authtempo/hono

The Hono binding of authtempo. It runs where Hono runs: Workers, Node, Bun,
and Deno. It takes `hono` 4.13.13 or newer in 4 as a peer dependency.

1. Mount core: `app.on(["GET", "POST", "OPTIONS"], "/auth/*", authHandler(auth))`.
2. Read the session: `app.use("*", authSession({ auth }))`, then `getSession(c)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- On Workers, pass a function of the context: `authHandler((c) => getAuth(c.env))`.
- `authSession` reads no session for a route of core, and adds the renewed
  cookie to the answer after the sliding refresh.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every
  server binding.
