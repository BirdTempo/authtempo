# Changesets

`@changesets/cli` writes the versions and the changelogs of the released packages. It never publishes: only the owner publishes, by the runbook (spec 33 item 2).

## The keys of config.json

JSON has no comments, so this file holds the reason of each key.

- `fixed`: the one list of the released packages. Every package in the group gets one version, and a change to one package bumps every package. `check-packages` fails on a workspace package that is in neither list or in both.
- `ignore`: the workspace packages that never release (plan 12j deviation 8). The Changesets docs call `ignore` a tool for temporary use. Every package on `main` is private, so `privatePackages` cannot tell the two sets apart. `release/unreleased.json` holds the same names, each with its reason, and `check-packages` fails when the two lists differ.
- `privatePackages.version: true`: every package on `main` keeps `private: true`, which is the hold. Without this key, `changeset version` skips each private package, and no released package gets a version.
- `privatePackages.tag: false`: Changesets makes no git tag. The owner pushes one tag `v<version>` for the group, by the runbook.
- `changelog`: the default changelog of `@changesets/cli`. It needs no network and no token.
- `commit: false`: a person reads each version diff before the commit.
- `access: "public"`: the scope `@authtempo` publishes to the public npm registry (owner decision 1 of 2026-10-14).
- `baseBranch: "main"`: the branch that the changes are compared with.
- `updateInternalDependencies: "patch"`: an internal reference follows each bump. Each reference is `workspace:*`, so the pack writes the exact version.
- `linked: []`: the fixed group already gives one version, so no package is linked.

## When to write a changeset

Write one changeset for each change to a released package. Run `pnpm changeset` at the repository root, or write the file `.changeset/<name>.md` by hand:

```md
---
"@authtempo/core": minor
---

Add the schema version field to the package manifest.
```

The rules (`check-changesets`, plan 12j Task 4):

1. A change to a released package needs a changeset that names the package.
2. A test, a proof, a typetest, a fixture, and the README need no changeset. The `CHANGELOG.md` at a package root needs none: `changeset version` writes it on the release branch, and `check-records` holds it.
3. A file that the `files` field of the package packs always needs a changeset, also a proof or a README. A package with no `files` field packs each file. Each `files` entry is a plain path, with no glob and no `./`.
4. A change to `package.json` needs a changeset only when a runtime key changes. The runtime keys are `dependencies`, `peerDependencies`, `peerDependenciesMeta`, `optionalDependencies`, `exports`, `imports`, `main`, `types`, `typesVersions`, `type`, `bin`, `files`, `engines`, or `scripts`.
5. A changeset never names an unreleased package.
6. An empty changeset (no package lines) needs the body line `No release: <reason>`.
7. The body is Simplified Technical English. It names the change, not a plan number.
8. A change to a root input needs a changeset that names each package of its row. A root input is a file outside the package that `prepare` or a build reads. Examples are `tsconfig.base.json`, `LICENSE`, and an example that the CLI renders. `ROOT_INPUTS` in `scripts/release/src/lib/root-inputs.ts` lists them. In `.changeset/config.json` only `fixed` counts, so a new name in `ignore` needs no changeset.

## The bump

The group stays at 0.x until the owner names `1.0.0`. While the group is at 0.x, `check-changesets` fails on a `major`: from 0.x, `changeset version` writes `1.0.0` for a major.

- A break is a `minor` with a line that starts with `Breaking:`. The line can be the first line of the body or a later line. Start it at the line start, with no space, list marker, or quote marker in front. `check-changesets` fails each other form, such as `- Breaking:`, because `changeset version` hides it from `authtempo upgrade`.
- `check-changesets` fails a `Breaking:` line in a `patch` changeset and in a changeset that names no package. From `1.0.0`, a break is a `major`.
- A feature is a `minor`.
- A fix is a `patch`.

## The line forms

A break states what changed and what the user does:

```md
Breaking: `createAuth` needs the `secret` option. Pass the operator secret.
```

A security fix states the advisory and the fix:

```md
Security: Fix the session check for a revoked key (GHSA-xxxx-xxxx-xxxx).
```

`authtempo upgrade` prints each `Breaking:` line of each minor that the upgrade crosses.
