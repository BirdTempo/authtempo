# @authtempo/react-router

The React Router binding of authtempo, for the server middleware of React
Router 8. It takes `react-router` 8.4.0 or newer in 8 as a peer dependency.
React Router 8.4 needs Node 22.22 or newer (its engines field, read
2026-10-15). The binding adds no floor of its own.

1. Mount core: `app/routes/auth.$.ts` holds
   `export const { loader, action } = authRouteModule(getAuth);`.
2. Read the session: `app/root.tsx` holds
   `export const middleware = [authMiddleware({ auth: getAuth })];`, and a
   loader reads `getSession(context)`.
3. Protect paths: `authMiddleware({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- `protect` gets the path as React Router matched it: ".data" removed, each
  segment decoded once, a decoded "/" kept as `%2F`, and no resolution of "."
  or "..". So "/%61ccount" reaches the rule as "/account". Write a rule in
  decoded text: "/café", "/σ".
- A rule must hold for every path that the route matches. Use a prefix rule
  for a splat or a parameter, and name each form of an optional segment:
  ":lang?/account" renders for "/en/account", which a rule on "/account" does
  not name. A data request "/account/...data" reaches a splat route
  "account/*" as "/account/..", and an exact rule misses it.
- `next` keeps the page URL in URL form, with the case of the request.
- React Router matches a path without case by default, so "/ACCOUNT" runs the
  page of "/account". The binding folds case for `protect`: a path needs a
  session when the rule holds for the path or for its lower-case form. Still
  set `caseSensitive: true` on each protected route, so "/ACCOUNT" gets a 404.
- React Router ignores trailing slashes on every route that is not a splat, so
  "/account/" renders "/account". The rule gets the path as matched, its
  lower-case form, both forms with trailing slashes removed, and the matched
  path in the case of the route's own text ("/myaccount" on the route
  "myAccount" gives "/myAccount"). A path needs a session when the rule holds
  for any of them. Write a rule in the route's own text.
- A parameter value or a splat value keeps the case of the request: the route
  has no text for it. A rule on "/en/myAccount" for ":lang/myAccount" misses
  "/EN/MYACCOUNT". Compare such segments in lower case in the rule.
- The middleware reads no session for a route of core, and adds the renewed
  cookie to the page's answer after the sliding refresh.
- A function given to both `authRouteModule` and `authMiddleware` runs twice
  for a request to core, so make it return one instance per environment.
- React Router runs the loader of a resource route for an OPTIONS request,
  so core answers a cross-origin preflight to its routes.
