# Security policy

This file tells you how to report a fault in authtempo, and what the owner does with the report.

## Supported versions

| Minor | Status | Released | Security fixes until | Schema versions |
| --- | --- | --- | --- | --- |
| 0.1 | current | 2026-11-16 | none | 16 |

The current minor gets every fix. The previous minor gets security fixes for 3 months after the next minor ships. After that date, the previous minor is unsupported. A database at a schema version of a supported minor gets to the current schema version with one `authtempo migrate`. The table comes from `release/support.json`, and a check holds this file to it.

## How to report

Report a fault through one of the two channels, in this order:

1. [GitHub private vulnerability reporting](https://github.com/BirdTempo/authtempo/security/advisories/new) on the repository.
2. [security@authtempo.com](mailto:security@authtempo.com), when you have no GitHub account.

Do not open a public issue for a fault. Do not include a real user's data in the report.

## The answer time

- The first answer comes within 72 hours after the report.
- The triage result comes within 7 days after the report. It gives the severity by CVSS 4.0.
- A Critical or High fault gets a fix within 14 days after the triage.
- A Medium fault gets a fix in the next minor.
- A Low fault gets a fix when the owner decides.

## The disclosure window

The advisory becomes public at the fix release, or 90 days after the report, whichever comes first. A later date is possible only when the reporter asks for it in writing. The advisory gives credit to the reporter by name, if the reporter wants it.

## The advisory format

Each advisory is a GitHub Security Advisory on the repository, with a CVE request through GitHub. It states these facts:

- the affected versions
- the fixed version
- the severity by CVSS 4.0
- the weakness, as a CWE
- what an attacker can do
- the work-around, if one exists
- the credit

The changeset of the fix has a line that starts with `Security:` and names the advisory. So the changelog of each package states the fix.

## Supplier advisories

The owner reads each advisory of a runtime dependency of a released package. The owner also reads each advisory of the library whose API the compat package answers, in the range of versions that the compat package supports. Each read advisory is a dated entry in [the advisory record](https://github.com/BirdTempo/authtempo/blob/main/docs/security/advisories.md). The record is append-only. Each entry states whether the advisory affects authtempo, and why.

## Out of scope

These items are not faults of authtempo:

- the data of the demo sandbox
- the static files of the hosted site
- a fault that needs an app secret that the attacker already has
