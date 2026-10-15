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
- `protect` gets the path that Fastify's router matches: decoded once, so
  `/%61ccount` is `/account`, with no query and with dot segments kept. The
  hook applies the router options `caseSensitive`, `ignoreTrailingSlash`,
  `ignoreDuplicateSlashes`, and `useSemicolonDelimiter`, as the router does.
  With `caseSensitive: false`, the rule gets the path in lower case, so write
  the rule in lower case. Keep the router options and the rule in step:
  prefer a prefix rule, because a route with a parameter or a wildcard also
  matches paths under the prefix.
- `authRoutes` makes its route at registration. With a function in `auth`,
  the route is under "/auth" unless you set `basePath`. With an auth object,
  the route is under the auth object's base path.
- `toWebRequest` and `sendWebResponse` are the two seams to Fastify.
- Behind a TLS proxy, set `trustProxy` in the options of Fastify, so the
  sign-in redirect keeps https.
