---
title: Versioning policy
description: How the packages of authtempo take their versions, what a change of each kind costs, and how the docs follow them.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 10
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 12
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
sidebar:
  order: 90
---

**For:** a developer who updates the packages of authtempo, or a contributor who changes one.

**What it does:** this page states the version rules of the packages, the schema, and the docs.

## Before you start

- Read [Upgrades and schema versions](/docs/operations/upgrades/) for the steps of an update.

## The versions today

Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.

## The rules

| Change | Version |
| --- | --- |
| A change that breaks a caller: a removed export, a changed answer, a removed route | A major version |
| A new error code | A minor version |
| A new route, a new config key, a new export | A minor version |
| A fix that changes no answer that a caller reads | A patch version |
| A new schema version | A minor version, with its migration in each adapter |

- The error codes are stable strings. A code never changes its meaning, and a new code is a minor version.
- The schema version is a constant in core, apart from the package version. Each adapter refuses a database with an older schema version.
- Keep every `@authtempo` package of an app at the same version.

## The docs

- The docs version follows the package versions.
- Until the first release, the site has one docs tree, at `/docs/`.
- From the first minor release: one docs tree for each minor, the current tree at `/docs/`, and each earlier minor at `/docs/v<major>.<minor>/`.
- Each earlier tree builds from the git tag of its minor.
- A page carries no "since version" note until a second minor exists.

## Next

- [Changelog](/docs/changelog/)
- [Upgrades and schema versions](/docs/operations/upgrades/)
- [Error codes](/docs/reference/errors/)
