---
title: Deprecations
description: Each deprecated item of the authtempo packages, the version that deprecates it, and the version that removes it.
type: reference
sources:
  - release/deprecations.json
---

**For:** a developer who upgrades an app and must know what the next minor removes.

**What it does:** this page lists each entry of the deprecation register `release/deprecations.json`. A site check holds each entry of this page to the register, both ways.

## Before you start

- Read [Versioning policy](/docs/versioning/) for what a minor is.

## The rule

"For one release" means this: the item ships, with its deprecation line, in every version of the first minor that carries it. The next minor removes it.

The release check `check-deprecations` fails while an item stays at or above its removal version. `authtempo upgrade` prints each entry that an upgrade crosses, with a link to its section here.

## The entries

### authtempo-import

The alias binary authtempo-import, with the old flags of the import CLI. Run authtempo import instead.

- Deprecated since: `0.1.0`
- Removed in: `0.2.0`

### tempo-session-read

The read of the old session cookie tempo_session, and its move to __Host-tempo_session.

- Deprecated since: `0.1.0`
- Removed in: `0.2.0`

### handoff-oauth-reexports

The re-exports of makePkce, webCrypto, base64Url, parseReturnedUrl, and the types HandoffCrypto and Returned from @authtempo/handoff. Import them from @authtempo/client/oauth.

- Deprecated since: `0.1.0`
- Removed in: `0.2.0`

## Next

- [authtempo upgrade](/docs/reference/cli/upgrade/)
- [Changelog](/docs/changelog/)
- [Upgrades and schema versions](/docs/operations/upgrades/)
