# @authtempo/next

The Next.js binding of authtempo, for the App Router of Next 16. It imports
nothing of Next at run time. It takes `next` 16.4 or newer in 16 as a peer
dependency.

1. Mount core: `app/auth/[...path]/route.ts` holds
   `export const { GET, POST, OPTIONS } = authRouteHandlers(getAuth);`.
2. Read the session in a server component:
   `const session = await authSession(getAuth, await headers());`.
3. Protect paths in `proxy.ts`:
   `export const proxy = authProxy({ protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" });`.

- `getAuth` is a function that makes the auth instance at the first request,
  so `next build` reads no secret. An instance works too.
- `authSession` is a read with no write. A server component cannot set a
  cookie, so the read leaves the sliding refresh for the browser. The browser
  gets the renewed cookie from its own read of `/auth/session`, such as the
  read of the session store of `@authtempo/react`. An app with no such read
  calls `/auth/session` from the page.
- Without `auth`, `authProxy` checks only that a session cookie is present,
  or a bearer that starts with core's session token prefix. It does not check
  that the session is live: the page checks the session with `authSession`.
  Never trust the proxy alone.
- With `auth`, `authProxy` asks core, with no write: one storage read per
  protected request.
- The proxy sends `next` with the path and the query of the request. Keep
  secrets out of the query of a protected URL.
- The session cookie is `DEFAULT_COOKIE_NAME` of `@authtempo/core/credentials`
  (`__Host-tempo_session`). With that default, the proxy also reads the name
  before plan 12b, for one release. Pass `cookieName` when core's config sets one.
- Next 16 renamed middleware to proxy. A file named `middleware.ts` gets a
  deprecation warning from Next.
