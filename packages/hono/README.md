# @authtempo/hono

The Hono binding of authtempo. It runs where Hono runs: Workers, Node, Bun,
and Deno. It takes `hono` 4.13.13 or newer in 4 as a peer dependency.

1. Mount core: `app.on(["GET", "POST", "OPTIONS"], "/auth/*", authHandler(auth))`.
2. Read the session: `app.use("*", authSession({ auth }))`, then `getSession(c)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- On Workers, pass a function of the context: `authHandler((c) => getAuth(c.env))`.
  A function given to both `authSession` and `authHandler` runs twice for a
  request to core, so make it return one instance per environment.
- `authSession` reads no session for a route of core, and adds the renewed
  cookie to the answer after the sliding refresh.
- `protect` gets the path that Hono matched, in URL form, with its case kept.
  An escaped letter such as `%61` is decoded, and a space or a non-ASCII
  letter is encoded again: `/caf%C3%A9`, `/my%20account`. Write a rule for
  such a path in the encoded form, or use a rule on a prefix. The gate of
  `@authtempo/core/bindings` gives this form to every binding.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every
  server binding.
