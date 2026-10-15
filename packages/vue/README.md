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
- The session middleware reads the URL and the headers only, never the body.
- The session middleware reads no session for a route of core: core reads and renews it itself.
