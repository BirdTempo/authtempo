# @authtempo/express

The Express binding of authtempo, for Express 5 on Node 22.18 or newer. It
takes `express` 5.3.0 or newer in 5 as a peer dependency.

1. Mount core: `app.use("/auth", authHandler(auth))`.
2. Read the session: `app.use(authSession({ auth }))`, then `getSession(res)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- A body parser such as `express.json()` may run before the routes of core:
  the binding writes the parsed body again in its content type.
- `authSession` reads no session for a route of core, and adds the renewed
  cookie to the answer after the sliding refresh.
- `toWebRequest` and `sendWebResponse` are the two seams to Express.
- Behind a TLS proxy, set `app.set("trust proxy", ...)`, so the sign-in
  redirect keeps https.
