---
title: The SvelteKit package
description: The handle hook of @authtempo/sveltekit that mounts core and reads the session, and the Svelte store of the session.
type: reference
sources:
  - packages/sveltekit/README.md
  - packages/sveltekit/src/index.ts
  - packages/sveltekit/src/store.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
---

**For:** a developer of a SvelteKit 3 app.

**What it does:** this page lists the exports of the hook entry and of the store entry. The export checks hold this page to `packages/sveltekit/src/index.ts` and `packages/sveltekit/src/store.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core and read the session: `src/hooks.server.ts` holds `export const handle = authHandle({ auth: getAuth });`.
2. Add no route file: the hook sends each request of core to core.
3. Read the session in a load or an action: `locals.session`.
4. Protect paths: `authHandle({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

### The main entry

| Export | What it does |
| --- | --- |
| `authHandle` | Answers the `handle` hook: a request under the base path goes to core, and every other request gets `locals.session`. |
| `AuthSource` | The auth instance, or a function that makes it at the first request, so `vite build` reads no secret. |
| `SvelteKitAuthOptions` | The options of `authHandle`: `auth`, `protect`, `signInPath`, and `basePath`. |

### The store entry

`@authtempo/sveltekit/store` gives the session as a Svelte store.

| Export | What it does |
| --- | --- |
| `sessionStore` | Answers a `SessionReadable`: the session as a Svelte store, with `$session.data`, `$session.error`, `$session.isPending`, and `refetch`. |
| `authError` | Answers the code of `?auth_error=` in the URL, or `null`. |
| `AuthErrorCode` | The type of the code that `authError` answers: the answer of `client.readRedirectError`. |
| `Readable` | The store contract of Svelte that the store keeps. |
| `SessionReadable` | The type that `sessionStore` answers. |

## The path that protect gets

- `protect` gets the path as SvelteKit matched it: the path of `event.url`, decoded once by `decode_pathname` of Kit.
- That path keeps "%25" and "%2F" encoded, and keeps the case.
- A non-ASCII route reaches the rule decoded, such as "/café". Write the rule for that form.
- An app's `reroute` hook changes the path that SvelteKit matches, but the hook judges `event.url`. Write the rule for both forms of a rerouted protected path.
- A remote function at `/_app/remote/<id>` is outside the protect rule. It must check `locals.session` itself.

## How it behaves

- The package takes `@sveltejs/kit` 3.0.1 or a later 3 release as a peer dependency.
- `getAuth` is a function that makes the auth instance at the first request, so `vite build` reads no secret.
- Put other hooks beside it with `sequence` of `@sveltejs/kit/hooks`.
- The hook reads no session for a route of core. Core reads and renews the session itself.
- The hook skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- A path that SvelteKit decodes to a path of core, such as "/%61uth/x", goes to core. It never runs a page.
- Core matches its routes on the raw path. So core answers such a path as a path that it does not have: 404, or its own answer to an OPTIONS.
- After the sliding refresh, the page's answer carries the renewed session cookie.

## Cross-site form posts

- SvelteKit checks the origin of a form POST before the hook runs. It answers 403 to a cross-site form POST, and to a form POST with no `Origin` header.
- Sign in with Apple posts its callback as a form from the origin of Apple. Add that origin to the plugin config.
- The config is `sveltekit({ csrf: { trustedOrigins: ["https://appleid.apple.com"] } })`.
- A native OAuth client posts a form body to `/auth/oauth/token` with no `Origin` header. Only `trustedOrigins: ["*"]` lets it through.
- An app that serves native OAuth clients from SvelteKit sets `trustedOrigins` to `["*"]`. The origin and Fetch Metadata checks of core still guard the auth routes.
- The app's own form actions then need an origin check of their own.

## The Svelte store

- Make the store once per client. The store reads the session at its first subscriber in the browser.
- A server render gets the current state of the store, and starts no read. It never subscribes to the client store.
- Do not call `refetch()` in server code, because every render shares the store.
- `authError(client)` reads `?auth_error=` of the page. In a server render, give the URL: `authError(client, page.url.href)`.

## Next

- [The Astro package](/docs/reference/astro/)
- [The Next.js package](/docs/reference/next/)
