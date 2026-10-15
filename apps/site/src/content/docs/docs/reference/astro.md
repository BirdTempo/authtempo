---
title: The Astro package
description: The endpoint and the middleware of @authtempo/astro for on-demand pages.
type: reference
sources:
  - packages/astro/README.md
  - packages/astro/src/index.ts
  - docs/superpowers/plans/2026-10-14-11d2-bindings.md
sidebar:
  hidden: true
---

**For:** a developer of an Astro app with on-demand pages (`output: "server"`).

**What it does:** this page lists the exports of the package, the steps of the mount, and the path that the `protect` rule gets. The export check holds this page to `packages/astro/src/index.ts`.

## Before you start

- Read [The API reference](/docs/reference/api/) for the auth object that the package takes.

## Steps

1. Mount core: `src/pages/auth/[...path].ts` holds `export const ALL = authRoute(getAuth);` and `export const prerender = false;`.
2. Read the session: `src/middleware.ts` holds `export const onRequest = authMiddleware({ auth: getAuth });`.
3. Read the session in a page: `Astro.locals.session`.
4. Protect paths: `authMiddleware({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

## Exports

| Export | What it does |
| --- | --- |
| `authRoute` | Answers the endpoint of the routes of core. |
| `authMiddleware` | Answers the `onRequest` that sets `locals.session`, sends a person with no session on a protected path to the sign-in page, and adds the renewed cookie. |
| `AuthSource` | The auth instance, or a function that makes it at the first request, so `astro build` reads no secret. |
| `AstroAuthOptions` | The options of `authMiddleware`: `auth`, `protect`, `signInPath`, and `basePath`. |

## The path that protect gets

- `protect` gets the text that the router of Astro matched, from `context.originPathname`.
- That text is decoded until it stops changing, with duplicate slashes merged and the case kept.
- It has no trailing "/", and no `base` of the Astro config.
- A non-ASCII route reaches the rule decoded (`"/café"`). Write the rule for that form.
- The adapter resolves a literal or once-escaped dot segment before the match: `/account/..` is `/`. A twice-escaped one stays in the text: `/account/%252e%252e/x` reaches the rule as `/account/../x`. A prefix rule covers it.
- The `next` of the sign-in redirect comes from `context.url`.

## How it behaves

- The package takes `astro` 7.3.8 or a later 7 release as a peer dependency.
- `getAuth` is a function that makes the auth instance at the first request, so `astro build` reads no secret.
- The middleware reads no session for a route of core. Core reads and renews the session itself.
- The middleware skips the session read only when the raw path and the matched path are both under the base path. Else it judges the request as a page.
- Core matches its routes on the raw path. A path that Astro decodes to a path of core, such as `/%61uth/x`, never runs a page.
- When the rule holds for the decoded path and there is no session, the answer is the sign-in redirect. Else core answers 404.
- After the sliding refresh, the page's answer carries the renewed session cookie.
- Set `security.allowedDomains` to the host of your app. Without it, Astro gives each request the origin `localhost`.
- Then the sign-in redirect goes to `localhost`, and Astro refuses a form post from your app.
- The rule is `readGate` of `@authtempo/core/bindings`, the same in every server package.

## Next

- [The SvelteKit package](/docs/reference/sveltekit/)
- [The Next.js package](/docs/reference/next/)
