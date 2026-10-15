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

- The middleware reads no session for a route of core, and adds the renewed
  cookie to the page's answer after the sliding refresh.
- A function given to both `authRouteModule` and `authMiddleware` runs twice
  for a request to core, so make it return one instance per environment.
- React Router runs the loader of a resource route for an OPTIONS request,
  so core answers a cross-origin preflight to its routes.
