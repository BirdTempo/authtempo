# authtempo-release

The release checks of plan 12j. Never published: the name has no scope, and `private` is true.

Each check is a `.ts` file that Node runs by type stripping. Each check has a pure function and a vitest test over the fixtures in `test/fixtures/`. Its entry reads the repository and prints one summary line:

```
<name>: PASS|FAIL <key>=<n> ... failures=<n>
```

A check that reads zero items fails. Read the failure count from the summary line, not from the exit code alone.

## The checks

- `src/check-packages.ts`: each workspace package has its own name and is in exactly one list. The released list is `fixed[0]` of `.changeset/config.json`, the one fixed group, and `linked` is empty. The unreleased list is `release/unreleased.json`, with one reason for each package, and the same names are in `ignore` of `.changeset/config.json`. Each released package is private on `main` and has the group version. Each reference to a workspace package, scoped or not, and each `@authtempo` reference is `workspace:*`. A released package names no unreleased package in `dependencies`, `peerDependencies`, or `optionalDependencies`.
- `src/check-changesets.ts`: each change to a released package since the merge base with `main` has a changeset that names the package. The rules are in `.changeset/README.md`. Only a changeset that is new since the merge base counts. A changeset on `main` covers nothing on the branch, also when the branch changes it. `changeset status` runs beside it as a note, and its exit code never decides.
- `src/check-records.ts`: each changelog, the advisory record, and each shipped migration at the merge base with `main` is in the working tree with the same bytes. A changelog grows at the top, and the advisory record grows at the end. `RECORD_GLOBS` holds the rule of each file.

Each git test makes its own repository in the temp folder (`TMPDIR`) and never reads the history of this repository.

Run a check from the repository root. The `ref` is `main` when you give none:

```sh
node scripts/release/src/check-packages.ts
node scripts/release/src/check-changesets.ts [ref]
node scripts/release/src/check-records.ts [ref]
```

Run the tests with the cache off:

```sh
pnpm turbo run test typecheck --filter=authtempo-release --force
```

## A new workspace package

Put the package in exactly one list. To release it, add its name to `fixed[0]` of `.changeset/config.json`. To keep it unreleased, add its name to `ignore` of `.changeset/config.json` and to `release/unreleased.json` with one reason. `check-packages` fails until the package is in one list.
