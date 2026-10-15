# @authtempo/solid

The Solid binding of authtempo. It takes `solid-js` `^1.9.17` as a peer
dependency.

1. Put `AuthProvider` with one client at the root of the app.
2. Read the session: `const { session } = useSession()`, then `session().data`.
3. Show the failure of a provider sign-in: `useAuthError()` reads `?auth_error=` once.

- The subscription of `useSession` ends with the owner of the component.
- A server render shows the pending state and starts no read.
- A test in a DOM needs the browser build of `solid-js`: set the `browser`
  condition and inline `solid-js` in the vitest config.
- The server of Solid Start is `@authtempo/solid/start`. It takes
  `@solidjs/start` 2.0.6 or newer in 2 as an optional peer dependency.
  `src/routes/auth/[...path].ts` holds
  `const h = authRouteHandlers(getAuth)` and one named export per method
  (`export const GET = h.GET;`), and `src/middleware.ts` holds
  `export default createMiddleware({ onRequest: [authOnRequest({ auth: getAuth })] });`.
  An API route reads `getSession(event)`. Server code of a page reads
  `getSession(getRequestEvent())`, not `useSession`.
- Export every method of the handlers: GET, POST, PUT, PATCH, DELETE, and
  OPTIONS. HEAD falls back to GET. A method with no export falls through to
  the pages, and the middleware does not gate a path of core: a catch-all page
  would run for it with no session. With every export, core answers each
  method under its base path itself.
- Protect paths: `authOnRequest({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.
  A person with no session gets a 307 to the sign-in page, and no route runs.
- A server function runs at `/_server`, so a `protect` rule for a page does
  not cover the server functions that the page calls. Read
  `getSession(getRequestEvent())` in each server function that needs a session.
- `protect` gets the path as the routers of Solid Start 2.0.6 match it.
  That is the path of `request.url` after the URL parse, with one `/` at the
  end removed.
  The parse resolves `..`, `%2e`, a backslash, and a tab. No escape is
  decoded: `/%61ccount` reaches the rule as `/%61ccount`, and no route
  `/account` matches it.
- Write a non-ASCII path encoded, with escapes in upper case:
  `p === "/caf%C3%A9"`. Solid Router lower-cases a page path and its pattern,
  hex included, so `/caf%c3%a9` and `/CAF%C3%A9` run the page `/café`. The
  entry also asks `protect` with the lower-case path with each escape in upper
  case, so `p === "/caf%C3%A9"` protects `/caf%c3%a9`.
- An API route matches with case (radix3 1.1.2): `/MYACCOUNT` runs no route
  `/myAccount`, and answers 404. A page matches without case (Solid Router
  1.0.0 compares each static part in lower case): `/ACCOUNT` runs the page
  `/account`.
- Both routers remove one `/` at the end: `/account/` runs the route
  `/account`. radix3 runs a child route `/account/:id` for `/account//`, with
  an empty id.
- So the entry asks `protect` with the path as matched. It also asks with each
  `/` at the end removed (`/` stays `/`), and with both forms in lower case. It
  also asks with the lower-case forms with each escape in upper case. A path
  needs a session when the rule holds for any form. A rule
  `p === "/account"` protects `/ACCOUNT`, `/account/`, `/account//`, and
  `/ACCOUNT/`.
- Warning: a rule with an upper-case letter does not protect a page in
  another case. `p.startsWith("/myAccount")` holds for neither `/MYACCOUNT`
  nor `/myaccount`, and Solid Router runs the page `/myAccount` for both.
  For a page, compare in lower case:
  `protect: (p) => p.toLowerCase().startsWith("/myaccount")`.
- The rule gets the full path. Under a `server.baseURL`, write the rule with
  that base.
- The middleware writes the renewed cookie to the event's response headers.
  Solid Start 2.0.6 (h3 2.0.2) puts them on a page's answer and on an API
  route's answer below status 400.
- The origin of the redirect comes from the Host header, else from the
  origin of `auth.baseURL`. An absolute-form request line never sets it.
- The middleware reads no session for a route of core: core reads and renews
  it itself.
