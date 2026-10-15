# @authtempo/sveltekit

The SvelteKit binding of authtempo. It takes `@sveltejs/kit` 3.0.1 or newer
in 3 as a peer dependency.

1. Mount core and read the session: `src/hooks.server.ts` holds
   `export const handle = authHandle({ auth: getAuth });`. No route file is needed.
2. Read the session in a load or an action: `locals.session`.
3. Protect paths: `authHandle({ auth: getAuth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" })`.

- `getAuth` is a function that makes the auth instance at the first request,
  so `vite build` reads no secret.
- Put other hooks beside it with `sequence` of `@sveltejs/kit/hooks`.
- The hook reads no session for a route of core, and adds the renewed cookie
  to the page's answer after the sliding refresh.
- A remote function at `/_app/remote/<id>` is outside the protect rule, so it
  must check `locals.session` itself.

## Cross-site form posts

SvelteKit checks the origin of a form POST before the hook runs. It answers
403 to a cross-site form POST, and to a form POST with no `Origin` header.

- Sign in with Apple posts its callback as a form from Apple's origin. Add that
  origin to the plugin config:
  `sveltekit({ csrf: { trustedOrigins: ["https://appleid.apple.com"] } })`.
- A native OAuth client posts a form body to `/auth/oauth/token` with no
  `Origin` header. Only `trustedOrigins: ["*"]` lets it through.
- An app that serves native OAuth clients from SvelteKit sets `trustedOrigins`
  to `["*"]`. Core's own origin and Fetch Metadata checks still guard the auth
  routes. The app's own form actions then need an origin check of their own.
