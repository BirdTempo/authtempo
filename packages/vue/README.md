# @authtempo/vue

The Vue binding of authtempo, with the server of Nuxt in `@authtempo/vue/nuxt`.
It takes `vue` 3.5.43 or newer in 3 as a peer dependency, and `h3` 1.15.11 or
newer in 1 for the Nuxt entry.

In the browser:

1. Install the plugin: `app.use(authPlugin(createClient({ baseURL })))`.
2. Read the session: `const { session } = useSession()`, then `session.value.data`
   (in a template, `session.data`).
3. Show the failure of a provider sign-in: `useAuthError()` reads `?auth_error=` once.

On the server of Nuxt:

1. Mount core: `server/routes/auth/[...path].ts` holds `export default authEventHandler(getAuth);`.
2. Read the session: `server/middleware/session.ts` holds
   `export default authSessionHandler({ auth: getAuth });`, and a handler
   reads `getSession(event)`. A page reads `useRequestEvent()?.context.session`.
3. Protect paths: `authSessionHandler({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- The subscription of `useSession` ends with the component's scope.
- A server render shows the pending state, and starts no subscription and no read.
- The session middleware reads the URL and the headers only, never the body.
- `protect` guards a page load from the server only. A `<NuxtLink>` navigation
  renders the page in the browser and never reaches the server middleware.
  Read private data only in a server route that calls `getSession(event)`, read
  the session in the browser with `useSession`, or link with plain `<a>` tags
  so that each page load reaches the server.
- The session middleware gives `protect` the path decoded once, as h3 decodes
  it (`%2F` and `%25` stay encoded). Vue Router matches a path in any case by default: set
  `router: { options: { sensitive: true } }` in `nuxt.config.ts`, or compare in
  lower case in `protect`. Prefer a prefix rule: the router also renders
  `/account/` for `/account`.
- The session middleware reads no session for a route of core: core reads and renews it itself.
