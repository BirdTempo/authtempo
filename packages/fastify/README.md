# @authtempo/fastify

The Fastify binding of authtempo, for Fastify 5 on Node 22.18 or newer. It
takes `fastify` 5.12.5 or newer in 5 as a peer dependency.

1. Mount core: `await app.register(authRoutes({ auth }))`.
2. Read the session: `app.decorateRequest("authSession", null)` and
   `app.addHook("onRequest", authSession({ auth }))`, then `getSession(request)` in a route.
3. Protect paths: `authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- The routes of core read the body as it came: in the plugin's scope no
  parser of Fastify runs, so a form post works with no `@fastify/formbody`.
- The field is `request.authSession`, not `request.session`, which
  `@fastify/session` owns.
- The hook reads no session for a route of core, and adds the renewed cookie
  to the answer after the sliding refresh.
- Each Set-Cookie line of core is added to the answer. A line that an
  earlier hook set stays.
- `protect` gets the path as Fastify's router matched it, not the URL form.
  The router decodes the path once: `/%61ccount` is `/account`, and
  `/caf%C3%A9` is `/café`. It keeps `%25` and the reserved escapes such as
  `%2F`, drops the query, and keeps dot segments. The hook applies the router
  options `ignoreTrailingSlash`, `ignoreDuplicateSlashes`, and
  `useSemicolonDelimiter`, as the router does.
- The hook folds case and fails closed: a path needs a session when
  `protect(path)` or `protect(path.toLowerCase())` is true. So write the rule
  in lower case. This holds with `caseSensitive: false` too. The `next` value
  of the redirect keeps the case of the request.
- Prefer a prefix rule: a route with a parameter or a wildcard also matches
  paths under the prefix.
- A request line in absolute form (`GET http://host/path`) is judged by its
  path on the origin of the Host header.
- `authRoutes` makes its route at registration. With a function in `auth`,
  the route is under "/auth" unless you set `basePath`. With an auth object,
  the route is under the auth object's base path.
- `toWebRequest` and `sendWebResponse` are the two seams to Fastify.
- Behind a TLS proxy, set `trustProxy` in the options of Fastify, so the
  sign-in redirect keeps https.
