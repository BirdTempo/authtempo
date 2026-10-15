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
- `protect` gets the path that Express's router matched, in URL form, with its
  case kept. Express's router does not decode an escaped letter such as `%61`,
  and a space or a non-ASCII letter is encoded again: `/caf%C3%A9`,
  `/my%20account`. Write a rule for such a path in the encoded form, or use a
  rule on a prefix.
- Express matches without case by default, on the app and on each
  `express.Router()`. So the binding folds case: it protects a path when
  `protect` is true for the path or for its lower case. Also set
  `app.set("case sensitive routing", true)`, so "/ACCOUNT" gets a 404.
- Behind a TLS proxy, set `app.set("trust proxy", ...)`, so the sign-in
  redirect keeps https.
