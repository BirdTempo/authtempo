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
2. A test, a proof, a typetest, a fixture, and the README need no changeset.
3. A change to `package.json` needs a changeset only when a runtime key changes: `dependencies`, `peerDependencies`, `peerDependenciesMeta`, `optionalDependencies`, `exports`, `main`, `types`, `bin`, `files`, or `engines`.
4. A changeset never names an unreleased package.
5. An empty changeset (no package lines) needs the body line `No release: <reason>`.
6. The body is Simplified Technical English. It names the change, not a plan number.

## The bump

The group stays at 0.x until the owner names `1.0.0`.

- A break is a `minor` with a line that starts with `Breaking:`.
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
