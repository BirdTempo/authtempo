# @authtempo/solid

The Solid binding of authtempo. It takes `solid-js` 1.9.17 or newer in 1 as
a peer dependency.

1. Put `AuthProvider` with one client at the root of the app.
2. Read the session: `const { session } = useSession()`, then `session().data`.
3. Show the failure of a provider sign-in: `useAuthError()` reads `?auth_error=` once.

- The subscription of `useSession` ends with the owner of the component.
- A test in a DOM needs the browser build of `solid-js`: set the `browser`
  condition and inline `solid-js` in the vitest config.
- A SolidStart server route mounts core with no binding:
  `auth.handle(event.request)`.
