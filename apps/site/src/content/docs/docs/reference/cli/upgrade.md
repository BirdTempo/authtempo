---
title: authtempo upgrade
description: Move every authtempo package of an app to one version, and print the Breaking lines, the deprecations, and the next steps.
type: reference
sources:
  - packages/cli/src/commands/upgrade.ts
  - packages/cli/src/upgrade-core.ts
  - packages/cli/src/help/upgrade.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 33
  - docs/superpowers/plans/2026-10-14-12j-release-program.md "Task 10"
sidebar:
  order: 30
---

**For:** a developer who moves an app to a newer authtempo release.

**What it does:** this page lists what `authtempo upgrade` reads and writes, its flags, its exit codes, and its JSON document.

## Before you start

- An app with each `@authtempo` package at one version in its `package.json`. [Upgrades and schema versions](/docs/operations/upgrades/) tells why the packages keep one version.
- A backup of the database, for a release that changes the schema version. [Backups](/docs/operations/backups/) tells how.

The command reads the registry. It works from the first release.

## The command

```sh
authtempo upgrade --dry-run
authtempo upgrade
authtempo upgrade apps/api --to 0.2.1
```

| Flag | What it does |
| --- | --- |
| `--to <version>` | The target version, such as 0.2.1. The default is the latest version of `@authtempo/core`. A target below the installed version stops the command. |
| `--registry <url>` | The npm registry to read. The default is `https://registry.npmjs.org/`. http is for localhost, 127.0.0.1, or [::1] only. |
| `-n`, `--dry-run` | Prints the change and writes nothing. The exit code is the code of a real run. |
| `--json` | Prints the document of [The JSON](#the-json). The human lines go to stderr. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The versions are written, or the app is already at the target. |
| 1 | A crossed minor has a Breaking line. The versions are written. Read each Breaking line before the install. |
| 2 | A usage error, a stop, or no answer from the registry. The command wrote nothing. |

## What it reads

1. The `package.json` of the folder, or of the current folder. The command lists each `@authtempo` key of `dependencies` and `devDependencies`, and the alias `"better-auth": "npm:@authtempo/compat-better-auth@<version>"`.
2. The registry document of each package, one read each, with a time limit of 10 seconds. The target is `--to`, or the `latest` tag of `@authtempo/core`.
3. The `authtempo` key of the target core: the schema version, the Breaking lines of each minor, and the deprecations.

The command stops with exit 2 and writes nothing in each of these cases:

- The file has no `@authtempo` package.
- The file has two versions of the packages. Set one version by hand first.
- A value is not a version, such as `workspace:*`.
- The target is below the installed version.
- A package has no version at the target on the registry.
- The registry gives no answer in 10 seconds.

## What it writes

The command changes the version text of each entry in `package.json`, and nothing else. The key order and the indent stay. A version with `^` or `~` becomes the exact version. The alias keeps its `npm:` form.

The command runs no install and no other program. It prints the install command of the lockfile in the folder, such as `pnpm install` for `pnpm-lock.yaml`.

## What it prints

- One line for each package, from the installed version to the target.
- For each crossed minor: the changelog link, and each Breaking line of that minor.
- Each deprecated item that the range removes, with its docs link.
- The next steps: the install, and `authtempo migrate` when the schema version changes. [Upgrades and schema versions](/docs/operations/upgrades/) tells the order of the migration and the deploy.

## The JSON

| Key | What it holds |
| --- | --- |
| `from` | The installed version, or null in the document of a stop. |
| `to` | The target version, or null in the document of a stop. |
| `packages` | One row for each entry of `package.json`: `name` (the key, so the alias is `better-auth`), `from`, and `to`. The list is empty when the app is current. |
| `schema` | The schema version of the installed core and of the target core, and `migrate`, which is true when they differ. Null when the app is current. |
| `breaking` | One row for each crossed minor: `minor` and its Breaking `lines`. |
| `deprecations` | One row for each item that the range removes: `id`, `removeIn`, and `docs`. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop or a usage error holds the empty values of each key, `exit: 2`, and the reason in `stopped`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

The MCP server has no tool for this command. A person reads each Breaking line before the install.

## Next

- [Upgrades and schema versions](/docs/operations/upgrades/)
- [Changelog](/docs/changelog/)
- [The CLI](/docs/reference/cli/)
