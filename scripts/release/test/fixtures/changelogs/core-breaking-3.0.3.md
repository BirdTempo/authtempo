# @authtempo/core

## 0.1.0

### Minor Changes

- ec9a35f: Breaking: the `baz` route moves to `/v2/baz`. Call the new path.
- ec9a35f: Remove the `foo` option of `createAuth`.
  Breaking: `createAuth` refuses the `foo` option. Remove it from the config.
  Breaking: `createAuth` refuses the `bar` option too. Remove it from the config.

### Patch Changes

- ec9a35f: Fix the session check of a revoked key.
