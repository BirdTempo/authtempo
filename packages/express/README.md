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
- `protect` gets the path exactly as Express's router matched it: the raw
  request path, with its case. It is not decoded (`%61` stays `%61`), and "."
  and ".." are not resolved.
- Express matches without case by default, on the app and on each
  `express.Router()`, and the hex digits of an escape too. So the binding also
  tests the lower-case form of the path, and the lower-case form with
  upper-case escape hex. It protects the path when `protect` is true for any
  form. Also set `app.set("case sensitive routing", true)`, so "/ACCOUNT" gets
  a 404.
- Write a rule for a non-ASCII path in the escaped form, such as
  `p.startsWith("/caf%C3%A9")`. Node answers 400 to a raw UTF-8 request line
  before Express runs.
- Behind a TLS proxy, set `app.set("trust proxy", ...)`, so the sign-in
  redirect keeps https.
