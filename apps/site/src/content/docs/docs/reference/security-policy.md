---
title: Security policy
description: How to report a fault in authtempo, the times of the answer and the disclosure, and where the full policy is.
type: reference
sources:
  - SECURITY.md
  - release/repository.json
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 33
  - docs/superpowers/plans/2026-10-14-12j-release-program.md "Task 13"
---

**For:** a person who finds a fault in authtempo, or a developer who reads the security promises before an update.

**What it does:** this page states the channels and the times of the security policy. Each sentence of the sections How to report and The times is a copy of `SECURITY.md`. A site check holds each copy equal to the file.

## Before you start

- Read [Versioning policy](/docs/versioning/) for the support window of each minor.

## The policy

The full policy is on the [security page](/security/) of this site, and in [SECURITY.md](https://github.com/authtempo/authtempo/blob/main/SECURITY.md) at the repository root.

## How to report

Until the first release, the two channels are not open, and the times of this policy do not apply.

Report a fault through one of the two channels, in this order:

1. [GitHub private vulnerability reporting](https://github.com/authtempo/authtempo/security/advisories/new) on the repository.
2. [security@authtempo.com](mailto:security@authtempo.com), when you have no GitHub account.

Do not open a public issue for a fault. Do not include a real user's data in the report.

## The times

- The first answer comes within 72 hours after the report.
- The triage result comes within 7 days after the report.
- The advisory becomes public at the fix release, or 90 days after the report, whichever comes first.

## Next

- [Versioning policy](/docs/versioning/)
- [Threat model](/docs/concepts/threat-model/)
