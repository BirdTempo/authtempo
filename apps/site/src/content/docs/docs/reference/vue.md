---
title: The Vue package
description: The plugin and the composables of @authtempo/vue, and the server of Nuxt in @authtempo/vue/nuxt.
type: reference
sources:
  - packages/vue/README.md
  - packages/vue/src/index.ts
  - packages/vue/src/nuxt.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of a Vue app, or of a Nuxt app.

**What it does:** this page lists the exports of the two entries, and the paths that the `protect` rule gets. The export checks hold this page to `packages/vue/src/index.ts` and `packages/vue/src/nuxt.ts`.

## Before you start

- Read [The client package](/docs/reference/client/) for the session store under the composables.

## Steps

In the browser:

1. Install the plugin: `app.use(authPlugin(createClient({ baseURL })))`.
2. Read the session: `const { session } = useSession()`, then `session.value.data`. In a template, read `session.data`.
3. Show the failure of a provider sign-in: `useAuthError()` reads `?auth_error=` once.

On the server of Nuxt:

1. Mount core: `server/routes/auth/[...path].ts` holds `export default authEventHandler(getAuth);`.
2. Read the session: `server/middleware/session.ts` holds `export default authSessionHandler({ auth: getAuth });`.
3. Read the session in a handler with `getSession(event)`. A page reads `useRequestEvent()?.context.session`.
4. Protect paths: `authSessionHandler({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

### The browser entry

| Export | What it does |
| --- | --- |
| `authPlugin` | Answers the plugin that gives a client to every composable: `app.use(authPlugin(client))`. |
| `useSession` | Answers a `UseSession`: `session`, a ref of `{ data, error, isPending, isRefetching }`, and `refetch`. |
| `useClient` | Answers the client of the plugin. It throws when the plugin is not installed. |
| `useAuthError` | Answers the code of `?auth_error=` in the URL, read once, or `null`. |
| `AuthErrorCode` | The type of the code that `useAuthError` answers: the answer of `client.readRedirectError`. |
| `UseSession` | The type that `useSession` answers. |

### The Nuxt entry

`@authtempo/vue/nuxt` is for the server of Nuxt, which runs on h3 1.

| Export | What it does |
| --- | --- |
| `authEventHandler` | Answers the handler of `server/routes/auth/[...path].ts`. |
| `authSessionHandler` | Answers the server middleware that sets `event.context.session`, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `getSession` | Answers the session that the middleware set, or `null`. |
| `AuthSource` | The auth instance, or a function that makes it at the first request, so `nuxt build` reads no secret. |
| `NuxtAuthOptions` | The options of `authSessionHandler`: `auth`, `protect`, `signInPath`, and `basePath`. |

## In the browser

- The package takes `vue` 3.5.43 or a later 3 release as a peer dependency. The Nuxt entry takes `h3` 1.15.11 or a later 1 release as an optional peer.
- The subscription of `useSession` ends with the scope of the component.
- A server render shows the pending state. It never subscribes to the client store, and starts no read.
- In Nuxt, install the plugin on both sides: `app/plugins/authtempo.ts`, not `.client.ts`. Give it `baseURL: useRequestURL().origin`.
- Else a page that calls `useSession` fails in the server render.

## The paths that protect gets

- `protect` gets the path as h3 matched it: the raw request path, decoded once, with `%2F` and `%25` kept encoded.
- Dot segments stay, and slashes are not merged. `/account/%2e%2e` reaches the rule as `/account/..`, which a child route `/account/[id]` matches.
- A non-ASCII route reaches the rule decoded: write `p === "/café"`, not `"/caf%C3%A9"`.
- h3 decodes `%3F` and `%23` into the path, so the text of h3 for `/account%3F` is `/account?`.
- The page router of Nuxt reads another path. It cuts the text at the first `?`, but not at `#`.
- For example, `/secret/x%23y` renders `/secret/[id]` with the id `x#y`.
- The page router also treats `\` as `/`, resolves `.` and `..`, and matches with or without a trailing `/`.
- So `/account/`, `/account/.`, and `/account%3F` all render the page of `/account`.
- The middleware runs `protect` on four forms, each once, and on each form in lower case. The first form is the text of h3, and the second is that text cut at the first `?`.
- The third form is the page path: cut at `?`, with `\` as `/`, `.` and `..` resolved, and no trailing `/`.
- The page path is still decoded, so `/café/` gives `/café`. The fourth form, an extra one, is the text cut at the first `#`.
- A path needs a session when the rule holds for any form. So an exact rule `p === "/account"` guards every path that renders that page.
- An extra form only adds a redirect.
- Vue Router compares a path in any case by default. Set `router: { options: { sensitive: true } }` in `nuxt.config.ts`, or compare in lower case in `protect`.
- Prefer a prefix rule: the router also renders `/account/` for `/account`.

## On the server of Nuxt

- `protect` guards a page load from the server only. A `<NuxtLink>` navigation renders the page in the browser, and never reaches the server middleware.
- So read private data only in a server route that calls `getSession(event)`. Else read the session in the browser with `useSession`.
- Or link with plain `<a>` tags, so that each page load reaches the server.
- The session middleware reads the URL and the headers only, never the body.
- The session middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that h3 decodes to a path of core, such as `/%61uth/x`, never runs a page.
- When the rule holds for the decoded path and there is no session, the answer is the sign-in redirect. Else core answers 404.
- On Node, the origin of the redirect comes from the protocol of h3 and the Host header. It never comes from a request line in absolute form.
- A Host that does not parse as one host falls back to the origin of `auth.baseURL`, so no request answers 500.
- A web handler, such as a Worker preset, keeps the URL of the request, and the origin comes from that URL.

## Next

- [The Solid package](/docs/reference/solid/)
- [The React package](/docs/reference/react/)
