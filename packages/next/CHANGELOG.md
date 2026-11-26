# @authtempo/next

## 0.2.0

### Minor Changes

- 1a22e8a: Breaking: core reads the old session cookie `tempo_session` no more, and the router does not move it.
  
  Version 0.1 read `tempo_session` when a request had no `__Host-tempo_session`, and moved the token to the new name. That read is gone. A browser that holds only the old cookie signs in again. The Better Auth shim and the proxy of `@authtempo/next` read the old name no more.
  
  `@authtempo/core/credentials` no longer exports `LEGACY_COOKIE_NAME`. `sessionCookieNames()` answers `{ cookieName }` only, and `readSessionToken` reads no `legacyCookieName`. The resolved config has no `legacyCookieName`.
  
  A sign-out clears the session cookie only. `LEGACY_SESSION_COOKIE` stays: the config refuses that name for each other cookie of core, and the Expo storage key of the shim holds it.

### Patch Changes

- Updated dependencies [c79bf6c]
- Updated dependencies [d182103]
- Updated dependencies [e386ff8]
- Updated dependencies [227d5c6]
- Updated dependencies [ee41ba3]
- Updated dependencies [b456151]
- Updated dependencies [bc4768d]
- Updated dependencies [8b3ccc6]
- Updated dependencies [2c2dcbd]
- Updated dependencies [7aa0599]
- Updated dependencies [1a22e8a]
- Updated dependencies [5a0384d]
- Updated dependencies [1b83f8c]
- Updated dependencies [04792aa]
- Updated dependencies [d64537a]
- Updated dependencies [01e1b69]
- Updated dependencies [35325a9]
- Updated dependencies [4d41f15]
  - @authtempo/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @authtempo/core@0.1.1

## 0.1.0

### Patch Changes

- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [7762d73]
- Updated dependencies [39e5ca1]
- Updated dependencies [0347b96]
- Updated dependencies [b8b54a4]
- Updated dependencies [e239c83]
- Updated dependencies [28f0699]
- Updated dependencies [b6da6a3]
- Updated dependencies [552820d]
- Updated dependencies [abf1b79]
- Updated dependencies [f82781f]
- Updated dependencies [d9fe45b]
- Updated dependencies [30e85d8]
- Updated dependencies [a1c5ad8]
- Updated dependencies [48a2484]
- Updated dependencies [108fbf5]
- Updated dependencies [8953ed5]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/core@0.1.0
