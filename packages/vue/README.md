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
  In Nuxt, install the plugin on both sides (`app/plugins/authtempo.ts`, not
  `.client.ts`), with `baseURL: useRequestURL().origin`. Else a page that calls
  `useSession` fails in the server render.
- The session middleware reads the URL and the headers only, never the body.
- `protect` guards a page load from the server only. A `<NuxtLink>` navigation
  renders the page in the browser and never reaches the server middleware.
  Read private data only in a server route that calls `getSession(event)`, read
  the session in the browser with `useSession`, or link with plain `<a>` tags
  so that each page load reaches the server.
- `protect` gets the path exactly as h3 matched it: the raw request path
  decoded once, with `%2F` and `%25` kept encoded. Dot segments stay
  (`/account/%2e%2e` reaches the rule as `/account/..`, which a child route
  `/account/[id]` matches), and slashes are not merged. A non-ASCII route
  reaches the rule decoded: write `p === "/café"`, not `"/caf%C3%A9"`. h3
  decodes `%3F` and `%23` into the path, so h3's text for `/account%3F` is
  `/account?`. Nuxt's page router reads another path: it cuts the text at the
  first `?` (not at `#`: `/secret/x%23y` renders `/secret/[id]` with the id
  `x#y`), treats `\` as `/`, resolves `.` and `..`, and matches with or
  without a trailing `/`. So `/account/`, `/account/.`, and `/account%3F` all
  render the page of `/account`. The middleware runs `protect` on four forms,
  each once, in this order: the h3 text; the text cut at the first `?`; the
  page path (cut at `?`, `\` as `/`, `.` and `..` resolved, no trailing `/`,
  still decoded, so `/café/` gives `/café`); and, as an extra form, the text
  cut at the first `#`. A path needs a session when the rule holds for any
  form, so an exact rule `p === "/account"` guards every path that renders
  that page. An extra form only adds a redirect.
- Vue Router compares a path in any case by default. Set
  `router: { options: { sensitive: true } }` in `nuxt.config.ts`, as the
  example does, or compare in lower case in `protect`. Prefer a prefix rule:
  the router also renders `/account/` for `/account`.
- The session middleware reads no session for a route of core: core reads and renews it itself.
