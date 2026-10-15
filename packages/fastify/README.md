# @authtempo/fastify

The Fastify binding of authtempo, for Fastify 5 on Node 22.18 or newer. It
takes `fastify` 5.12.5 or newer in 5 as a peer dependency.

1. Mount core: `await app.register(authRoutes({ auth }))`. It mounts core for
   every method under the base path: DELETE, GET (with HEAD), OPTIONS, PATCH,
   POST, and PUT.
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
- `protect` gets the path exactly as Fastify's router matched it, decoded:
  find-my-way decodes the path once and keeps `%25`, so `/%61ccount` is
  `/account` and `/caf%C3%A9` is `/café`. It keeps the reserved escapes such
  as `%2F`, drops the query, and keeps dot segments and backslashes:
  `/account/..` reaches the rule as `/account/..`. Write the rule for that
  matched form. find-my-way stores a `%` of a route as `%25`, so a route
  `/x/%2e` is the path `/x/%252e` for the rule.
- The hook fails closed on the router options. It reads none of them. It
  runs the rule on each form that the router can match: the path as it is,
  with duplicate slashes merged (`ignoreDuplicateSlashes`), with the last
  slash cut (`ignoreTrailingSlash`), and cut at the first `;`
  (`useSemicolonDelimiter`). A path needs a session when the rule holds for
  one form.
- The hook folds case and fails closed: the rule also runs on each form in
  lower case. find-my-way compares with `toLowerCase` when `caseSensitive` is
  false, so write the rule in lower case. Keep that rule for the text after
  `%25`: the upper-case step below does not change it.
- find-my-way compares the hex digits of a kept escape as text, so `/q%3fx`
  and `/q%3Fx` reach the same route. The hook also runs the rule with each
  escape in upper case, so write a kept escape in upper case: `%3F`, `%2F`.
- The `next` value of the redirect is the path and the query of the request,
  as a URL reads them. One decode by the router gives back the page that the
  person asked for: `/account/a%2Fb` returns to `/account/a%2Fb`, and an
  escaped backslash stays escaped.
- Prefer a prefix rule: a route with a parameter or a wildcard also matches
  paths under the prefix.
- A request line in absolute form (`GET http://host/path`) is judged by its
  path on the origin of the Host header. A Host header that does not parse
  falls back to the origin of core's `baseURL`, so no request gets a 500 of
  the binding's own.
- `authRoutes` makes its route at registration. With a function in `auth`,
  the route is under "/auth" unless you set `basePath`. With an auth object,
  the route is under the auth object's base path.
- `toWebRequest` and `sendWebResponse` are the two seams to Fastify.
- Behind a TLS proxy, set `trustProxy` in the options of Fastify, so the
  sign-in redirect keeps https.
