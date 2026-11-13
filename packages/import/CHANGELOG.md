# @authtempo/import

## 0.1.0

### Patch Changes

- f9e9b1d: The password row of a new unverified user is now pending until the import activates it, after its other writes, as in a repair. A sign-in with it fails until then. A run that stops after that pending create leaves the row, and a later run counts it as missing. The record is then `partial`, and a repair writes the password again.
  
  On D1 the import of a new unverified user with a password sends two more queries, the activation.
- f2f1af1: The import of an unverified user, new or repaired, now holds the claim of the user for its writes, through core's `holdClaim`. It takes the hold before its first credential write and releases it before the activation of its pending rows. On Postgres and MySQL a claim of the user waits for the import's commit. On D1 a claim answers 409 `conflict` until the release, and a later claim works. So no claim deletes the claimant's rows before an import write and marks the address verified after it, while its lease lives. A claimant who holds the provider account of an imported social identity gets an unproved session after its activation, and the owner's claim ends it.
  
  When a claim holds the user first, or verified it before the hold, the import writes no credential. The record is then `partial` with `not repaired: claimed`. On D1 the lease guards only while it lives. So the release deletes only the import's own lease, and it fails when a claim took that lease. After the release, the import checks the user row by its address and flag, for a new user and for a repair. When the release or the check fails, the import deletes the rows it wrote, and the record is `partial` with `not repaired: claimed`. So a claim that verified the user before that check leaves no imported row. Under the hold a social identity goes in pending, with the provider `pending$<provider>`, and the activation after the check makes it live. No sign-in finds a pending row, so no imported credential is live before the check passes. When another user takes the identity on D1 before the activation, the import deletes its rows. The record is then `partial` with `not repaired: identity_taken`. A run that stops leaves the pending row, and a later run counts it as missing.
  
  A run that stops inside the hold leaves the lease on D1. A claim answers 409 for 60 seconds, and then it takes the lease. A repair reports `not repaired: claimed` until the sweep deletes the lease. The app's scheduled sweep deletes the lease at its first run 60 seconds or more after its write. The hold takes no stale lease, because a claim can run past the life of its lease.
  
  On D1 the import of a new unverified user sends six more queries. They are the lease create, the flag read of the hold, the release, and the check. An update in a D1 transaction counts two queries. A repair of an unverified user sends four more, because it keeps its own update of the user row as the check. A new unverified user with a social identity sends two more, for the activation of the identity. A verified user sends none more.
- da31e0f: The tarball no longer ships `worker/proof`. The two proof scripts need the repository to run, so they failed from an installed package.
- 49a63d9: Raise the Node floor in `engines` to 22.13. Each of the three packages needs a package with that floor: mcp needs the CLI, compat-better-auth needs the SQLite adapter, and import needs compat-better-auth.
- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- Updated dependencies [a1c5ad8]
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [48a2484]
- Updated dependencies [b8b54a4]
- Updated dependencies [abf1b79]
- Updated dependencies [d4bc280]
- Updated dependencies [28f0699]
- Updated dependencies [3f1c11c]
- Updated dependencies [762c5c3]
- Updated dependencies [d9fe45b]
- Updated dependencies [30e85d8]
- Updated dependencies [f513359]
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
- Updated dependencies [49a63d9]
- Updated dependencies [48a2484]
- Updated dependencies [108fbf5]
- Updated dependencies [8953ed5]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/adapter-d1@0.1.0
  - @authtempo/compat-better-auth@0.1.0
  - @authtempo/core@0.1.0
  - @authtempo/legacy-hashes@0.1.0
