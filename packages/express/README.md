# @authtempo/express

The Express binding of authtempo, for Express 5 on Node 22.18 or newer. It
takes `express` 5.2.1 or newer in 5 as a peer dependency. It runs on 5.2.1:
its router, parseurl, and each request and response method that it calls are
the same there. The Express adapter of NestJS 12 pins Express 5.2.1.

1. Mount core before the body parser of the app: `app.use("/auth", authHandler(auth))`, then `app.use(express.json())`.
2. Read the session: `app.use(authSession({ auth }))`, then `getSession(res)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- A body parser such as `express.json()` may run before the routes of core:
  the binding writes the parsed body again in its content type. Such a
  parser reads each body before core's cap and before its session check, and
  it has no depth or item limit. Mount core first, or make the parser skip
  the base path of core. Do not give a parser the bodies of core's routes,
  not even on the two SSO connection paths only. On 2026-10-30, a parser ran
  on those two paths only, with their cap of 8 MiB as its limit. One body of
  nested arrays at that limit, with no sign-in, stopped a process with a
  heap of 256 MB. Never raise the limit of a parser for every route
  (https://authtempo.com/docs/reference/express/).
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
- With "case sensitive routing" off, write the rule in lower case, with each
  escape in upper-case hex (`%3F`). A rule with a capital letter, such as
  `p.startsWith("/myAccount")`, misses "/myaccount" and "/MYACCOUNT", which run
  the page of "/myAccount" with no session. Else set "case sensitive routing".
- Express routes with strict routing off by default, so `/account` also
  matches `/account/`. The binding also tests each form with its trailing
  slashes removed.
- An exact rule does not cover a route with a parameter, such as
  `/account{/:tab}`: `/account/%2F` runs it with `tab` "/". Use a prefix rule
  for it: `p === "/account" || p.startsWith("/account/")`.
- Write a rule for a non-ASCII path in the escaped form, such as
  `p.startsWith("/caf%C3%A9")`. Node answers 400 to a raw UTF-8 request line
  before Express runs.
- A Host header that does not parse gets no 500: the binding uses the origin
  of `auth.baseURL`, or "http://localhost" for an auth object with no `baseURL`.
- Behind a TLS proxy, set `app.set("trust proxy", ...)`, so the sign-in
  redirect keeps https.
