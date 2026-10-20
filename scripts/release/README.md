# authtempo-release

The release checks of plan 12j. Never published: the name has no scope, and `private` is true.

Each check is a `.ts` file that Node runs by type stripping. Each check has a pure function and a vitest test over the fixtures in `test/fixtures/`. Its entry reads the repository and prints one summary line:

```
<name>: PASS|FAIL <key>=<n> ... failures=<n>
```

A check that reads zero items fails. Read the failure count from the summary line, not from the exit code alone.

## The checks

- `src/check-packages.ts`: each workspace package has its own name and is in exactly one list. The released list is `fixed[0]` of `.changeset/config.json`, the one fixed group, and `linked` is empty. The unreleased list is `release/unreleased.json`, with one reason for each package, and the same names are in `ignore` of `.changeset/config.json`. Each released package is private on `main` and has the group version. Each reference to a workspace package, scoped or not, and each `@authtempo` reference is `workspace:*`. A released package names no unreleased package in `dependencies`, `peerDependencies`, or `optionalDependencies`.

Run a check from the repository root:

```sh
node scripts/release/src/check-packages.ts
```

Run the tests with the cache off:

```sh
pnpm turbo run test typecheck --filter=authtempo-release --force
```

## A new workspace package

Put the package in exactly one list. To release it, add its name to `fixed[0]` of `.changeset/config.json`. To keep it unreleased, add its name to `ignore` of `.changeset/config.json` and to `release/unreleased.json` with one reason. `check-packages` fails until the package is in one list.
