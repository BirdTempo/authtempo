---
title: Versioning policy
description: How the packages of authtempo take their versions, what a change of each kind costs, and how the docs follow them.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 6
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 10
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 12
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 33
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
  - docs/superpowers/plans/2026-10-14-12j-release-program.md "Task 13"
  - SECURITY.md
  - .changeset/config.json
sidebar:
  order: 90
---

**For:** a developer who updates the packages of authtempo, or a contributor who changes one.

**What it does:** this page states the version rules of the packages, the schema, and the docs.

## Before you start

- Read [Upgrades and schema versions](/docs/operations/upgrades/) for the steps of an update.
- Read [Security policy](/docs/reference/security-policy/) for how to report a fault.

## The versions today

Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.

## One version

Every released package has the same version. The first release is `0.1.0`. In 0.x a break is a minor with a "Breaking:" line in its changeset, a feature is a minor, and a fix is a patch. The owner names `1.0.0` in a later decision.

## The rules

| Change | In 0.x | From 1.0.0 |
| --- | --- | --- |
| A change that breaks a caller: a removed export, a changed answer, a removed route | A minor version, with a `Breaking:` line in its changeset | A major version |
| A new error code | A minor version | A minor version |
| A new route, a new config key, a new export | A minor version | A minor version |
| A fix that changes no answer that a caller reads | A patch version | A patch version |
| A new schema version | A minor version, with its migration in each adapter | A minor version, with its migration in each adapter |

- The error codes are stable strings. A code never changes its meaning, and a new code is a minor version.
- The schema version is a constant in core, apart from the package version. Each adapter refuses a database with an older schema version.
- Keep every `@authtempo` package of an app at the same version.

## The support window

No release exists yet. The first minor is the current minor at its release.

The current minor gets every fix. The previous minor gets security fixes for 3 months after the next minor ships. After that date, the previous minor is unsupported. A database at a schema version of a supported minor gets to the current schema version with one `authtempo migrate`.

Read [Security policy](/docs/reference/security-policy/).

## The docs

The site shows the docs of the current main only, at `/docs/`. A later plan adds a docs tree for each earlier minor.

## Next

- [Changelog](/docs/changelog/)
- [Upgrades and schema versions](/docs/operations/upgrades/)
- [Error codes](/docs/reference/errors/)
