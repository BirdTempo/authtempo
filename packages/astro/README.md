# @authtempo/astro

The Astro binding of authtempo, for on-demand pages (`output: "server"`). It
takes `astro` 7.3.8 or newer in 7 as a peer dependency.

1. Mount core: `src/pages/auth/[...path].ts` holds
   `export const ALL = authRoute(getAuth); export const prerender = false;`.
2. Read the session: `src/middleware.ts` holds
   `export const onRequest = authMiddleware({ auth: getAuth });`, and a page
   reads `Astro.locals.session`.
3. Protect paths: `authMiddleware({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- `getAuth` is a function that makes the auth instance at the first request,
  so `astro build` reads no secret.
- The middleware reads no session for a route of core, and adds the renewed
  cookie to the page's answer after the sliding refresh.
- Set `security.allowedDomains` to the host of your app. Without it, Astro gives
  each request the origin `localhost`, so the sign-in redirect goes to
  `localhost`, and Astro refuses a form post from your app.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every
  server binding.
