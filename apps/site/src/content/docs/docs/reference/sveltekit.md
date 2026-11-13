---
title: The SvelteKit package
description: The handle hook of @authtempo/sveltekit that mounts core and reads the session, and the Svelte store of the session.
type: reference
sources:
  - packages/sveltekit/README.md
  - packages/sveltekit/src/index.ts
  - packages/sveltekit/src/store.ts
  - packages/core/src/http/body-cap.ts
sidebar:
  hidden: true
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
5. On Workers with `@sveltejs/adapter-cloudflare` 8, pass the hook of the runtime: `authHandle({ auth: getAuth, waitUntil })`, with `import { waitUntil } from "cloudflare:workers"`. Adapter 8 sets no `event.platform`.

## Exports

### The main entry

| Export | What it does |
| --- | --- |
| `authHandle` | Answers the `handle` hook: a request under the base path goes to core, and every other request gets `locals.session`. |
| `AuthSource` | The auth instance, or a function that makes it at the first request, so `vite build` reads no secret. |
| `SvelteKitAuthOptions` | The options of `authHandle`: `auth`, `protect`, `signInPath`, `basePath`, and `waitUntil`. `waitUntil` keeps work alive after the answer. Default: the `waitUntil` of `event.platform.ctx`, then of the deprecated `event.platform.context`. Adapter 7 sets both, and adapter 8 sets neither. |

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

- A request of core gets the `waitUntil` of the option, else that of `event.platform.ctx`, else that of `event.platform.context`. The SMS of a phone code and the flush of the events run under it after the answer. With none, the work runs detached. On Workers core then waits for the work before it answers (ruling 29 of plan 12i).
- `@sveltejs/adapter-cloudflare` 8, the adapter for Kit 3, sets no `event.platform`. On Workers with it, pass `authHandle({ auth: getAuth, waitUntil })`, with `waitUntil` of `cloudflare:workers`. Without the option, the answer time can tell a known number, and core writes `observe.wait_until_missing`.
- The package takes `@sveltejs/kit` 3.0.1 or a later 3 release as a peer dependency.
- `getAuth` is a function that makes the auth instance at the first request, so `vite build` reads no secret.
- Put other hooks beside it with `sequence` of `@sveltejs/kit/hooks`.
- The sign-in redirect takes the origin of `event.request.url`, which the adapter builds.
- `@sveltejs/adapter-node` 6.0.0 reads no `ORIGIN` at run time. It writes `paths.origin` of the plugin config into the build.
- With `paths.origin` unset, the origin is `https://` plus the Host header. Over plain HTTP, set `paths.origin` at build time.
- The hook reads no session for a route of core. Core reads and renews the session itself.
- The hook sends a request to core when the raw path or the path that SvelteKit matched is under the base path. No page runs for such a request.
- A path that SvelteKit decodes to a path of core, such as "/%61uth/x", goes to core. It never runs a page.
- Core matches its routes on the raw path. So core answers such a path as a path that it does not have: 404, or its own answer to an OPTIONS.
- After the sliding refresh, the page's answer carries the renewed session cookie.

## The body limit of the Node adapter

- `@sveltejs/adapter-node` 6.0.0 limits a request body to `BODY_SIZE_LIMIT`. The default is `512K`, 524288 bytes (read 2026-10-30). The hook still runs: with `@sveltejs/kit` 3.0.1, the body stream fails only when a reader passes the limit.
- Three bodies of core can pass 512K: an SSO connection write, an ACS form, and a SCIM body of up to 1 MiB.
- Core reads such a body until its stream fails, and refuses the valid body as a body past its cap. An SSO connection write of 600000 bytes got the [`body_too_large`](/docs/reference/errors/#body_too_large) of core at `512K` (measured 2026-10-31). Then an SSO setup, a SAML sign-in, or a SCIM write fails.
- Set `BODY_SIZE_LIMIT` to `8M` in the environment of the server. That is 8 MiB, the largest cap of core. Core then reads at most the cap of each route.

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
