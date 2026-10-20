# authtempo-release

The release checks of plan 12j. Never published: the name has no scope, and `private` is true.

Each check is a `.ts` file that Node runs by type stripping. Each check has a pure function and a vitest test over the fixtures in `test/fixtures/`. Its entry reads the repository and prints one summary line:

```
<name>: PASS|FAIL <key>=<n> ... failures=<n>
```

A check that reads zero items fails. Read the failure count from the summary line, not from the exit code alone.

## The checks

- `src/check-packages.ts`: each workspace package has its own name and is in exactly one list. The released list is `fixed[0]` of `.changeset/config.json`, the one fixed group, and `linked` is empty. The unreleased list is `release/unreleased.json`, with one reason for each package, and the same names are in `ignore` of `.changeset/config.json`. Each released package is private on `main` and has the group version. The group version is never `0.0.x` above `0.0.0`, because the first release is `FIRST_RELEASE` (0.1.0). So a version pull request with only patch changesets fails before the merge. Each reference to a workspace package, scoped or not, and each `@authtempo` reference is `workspace:*`. A released package names no unreleased package in `dependencies`, `peerDependencies`, or `optionalDependencies`.
- `src/check-changesets.ts`: each change to a released package since the merge base with `main` has a changeset that names the package. The rules are in `.changeset/README.md`. Only a changeset that is new since the merge base counts. A changeset on `main` covers nothing on the branch, also when the branch changes it. `changeset status` runs beside it as a note, and its exit code never decides.
- `src/check-records.ts`: each changelog, the advisory record, and each shipped migration at the merge base with `main` stays the same. Each one is in the working tree with the same bytes. A changelog grows at the top, and the advisory record grows at the end. `RECORD_GLOBS` holds the rule of each file. No check holds the spec, the plan index, the plan files, or the ledgers: a review holds them.
- `src/check-support.ts`: `release/support.json` keeps owner decision 3 (spec 33 item 7). At most one minor is current. A minor with security fixes has a newer minor, and its last day is 3 months after the release of that minor, at most 7 days later. A minor past that day is unsupported. From each schema version of a supported minor, each `packages/adapter-*` has a migration file for each version up to `SCHEMA_VERSION`. An empty table passes with the note `no release exists`. The site check `check-security-policy` holds the table of `SECURITY.md` to the same file.
- `src/check-pack.ts <tarball>...`: each release tarball holds only `files` and the always-shipped files (`package.json`, `README.md`, `LICENSE`). It holds no forbidden name, and no binary file that its package does not declare. It holds each `exports`, `main`, `types`, and `bin` target, and each needed file of `release/pack-needs.json`. A need that ends in `/` is a folder with at least one file. Each released package has exactly one tarball. A tarball entry that is not a regular file or a folder fails, such as a link. A path with a `..` part fails too. The manifest has the group version, `license` MIT, the repository url and folder, `publishConfig` with public access and provenance, no `private`, and no `workspace:` text. The version is never `0.0.0`, which the scaffold reads as unpublished. It is never `0.0.x` above `0.0.0` either, because the first release is `FIRST_RELEASE` (0.1.0). The tarball has a `CHANGELOG.md` and a `LICENSE` with the bytes of the root `LICENSE`. Core's `authtempo.breaking` and `authtempo.deprecations` equal its changelog and `release/deprecations.json`. The dry run of Task 6 runs it in a release copy.
- `src/check-workflows.ts`: the two workflows under `.github/workflows/` keep the rules of spec 33 item 5. Each action is pinned to a 40-character commit SHA with a `# v<major>.<minor>.<patch>` comment. `ci.yml` runs on a pull request and a push to `main` with `contents: read`. `release.yml` runs on a push of a tag `v*` with top-level `permissions: {}`. Only its job `publish` has `id-token: write`, in the environment `release`. Each runner is an `ubuntu-<version>` runner of GitHub. No `run:` line holds an expression, no line names a token, and no step but `publish.ts` publishes. Each level holds only the keys that its rule names. `TOP_KEYS` holds the top, `JOBS` holds each job and step, and `WITH_KEYS` holds each `with` block. Any other key fails, such as `if`, `continue-on-error`, `env`, or `repository`. Each job has its steps in the order of `JOBS`, and each Node is at or above `NODE_FLOOR`. Each `node <path>` of a run line is a file of the tree. Each `pnpm <script>` is a root script, and each `node <path>` of that script exists. `LATER` lists the files that a later task adds, with the task and the plan line. The check skips them, and an entry whose file exists fails as stale. The check reads a YAML subset of its own and refuses any other form. A third workflow fails.
- `src/check-tag.ts <tag>`: the release tag is `v<version>` with no prerelease part, and it equals the group version. It is never `v0.0.x`, because the first release is `FIRST_RELEASE` (0.1.0). Its commit is on `origin/main`, or on `origin/release/<major>.<minor>` for a patch. The job `check` of `release.yml` runs it first.
- `src/publish.ts <folder>`: runs only in the job `publish` of `release.yml`. It checks the npm version against `NPM_FLOOR` and each tarball against `SHA256SUMS`. Then it publishes each version that the registry lacks, with `npm publish --access public`. Each package publishes after each package of its `dependencies`, `peerDependencies`, and `optionalDependencies`, so core goes first. The newest version gets the dist-tag `latest`, and an older minor gets `release-<major>.<minor>`. It stops at the first publish that fails. It prints one line for each version: published, not published, or skipped. So after a half release, the output names each version that npm has and each one that it lacks. It imports only Node modules and `src/lib/release-facts.ts`, because the job runs no install. Its tests replace each child process, so no test publishes.
- `src/prepare.ts`: it runs only in a release copy, a folder with the `.release-copy` file and no `.git`. For each released package, it removes `private`. It writes `license` from the root `package.json`, `repository` from `release/repository.json` with the package folder, and `publishConfig` with public access and provenance, after `version`. It copies the root `LICENSE` into the package folder. Core also gets `authtempo.breaking` from its `CHANGELOG.md` and `authtempo.deprecations` from `release/deprecations.json`. A released package with no `engines` fails.
- `src/dry-run.ts` (`pnpm release:dry-run [--keep]`): it stops with exit 2 on a dirty checkout. It copies `git archive HEAD` into a new temp folder and writes the `.release-copy` file. Then it installs offline and writes one minor changeset for the group. It runs `changeset version`, `prepare`, and the build of the released packages with the cache off. It packs each released package, runs `check-pack` on the tarballs, `npm publish <tarball> --dry-run` for each, and `pnpm publish -r --dry-run`. The pnpm list must equal the tarball list. Last, it installs the tarballs offline in a copy of `release/smoke/` and runs `smoke.mjs`. It stops at the first step that fails. It prints one line per tarball (`<name>@<version> <sha256> files=<n>`) and the summary line `release-dry-run: PASS packages=<n> of <n> version=<v> tarballs=<n> files=<f> smoke=<k> failures=0`. Each publish call has `--dry-run` and the registry `http://127.0.0.1:9`, where nothing listens. It never commits, tags, or pushes. It deletes the temp folder unless you give `--keep`.

The forbidden names are one list, `FORBIDDEN_PACK_NAMES` in `src/lib/pack-rules.ts`. Each older `proof/pack-files.mjs` imports it through `forbiddenMatch`, so a new name reaches every proof.

Each git test makes its own repository in the temp folder (`TMPDIR`) and never reads the history of this repository.

Run a check from the repository root. The `ref` is `main` when you give none:

```sh
node scripts/release/src/check-packages.ts
node scripts/release/src/check-changesets.ts [ref]
node scripts/release/src/check-records.ts [ref]
node scripts/release/src/check-support.ts
node scripts/release/src/check-workflows.ts
```

Run the tests with the cache off:

```sh
pnpm turbo run test typecheck --filter=authtempo-release --force
```

## A new workspace package

Put the package in exactly one list. To release it, add its name to `fixed[0]` of `.changeset/config.json`. To keep it unreleased, add its name to `ignore` of `.changeset/config.json` and to `release/unreleased.json` with one reason. `check-packages` fails until the package is in one list. A released package also needs its entry in `release/pack-needs.json`: the check-pack test fails until it exists.
