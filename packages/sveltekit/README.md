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
