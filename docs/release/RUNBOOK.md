# Release runbook

This runbook holds the steps of the owner for a release of the authtempo packages (spec 33 item 4.3). Only the owner runs these steps. The loop of plan 12j never publishes, tags, or pushes.

Each step states what breaks without it. The test `scripts/release/test/runbook.test.ts` holds each value of this file to the code, and holds the order of the steps. The site test `apps/site/test/check-pre-release.test.ts` holds the quotes of "The first release" to the site data.

## The values

| Value | Text | Source in the code |
| --- | --- | --- |
| The repository | `https://github.com/BirdTempo/authtempo` | `release/repository.json` |
| The npm scope | `@authtempo` | `SCOPE` in `scripts/release/src/lib/release-facts.ts` |
| The release workflow | `release.yml` | `WORKFLOW_FILE` |
| The workflow of each pull request | `ci.yml` | `CI_FILE` |
| The GitHub environment | `release` | `ENVIRONMENT` |
| The tag | `v<version>`, such as `v0.1.0` | `TAG_PREFIX` and `check-tag` |
| The branch of a patch of an older minor | `release/<major>.<minor>` | `check-tag` |
| The first release | `0.1.0` | `FIRST_RELEASE` |
| The key of a release date | `<name>@<version>` | `entryKey` in `apps/site/scripts/lib/feed.ts` |
| The lowest npm of the job `publish` | `11.5.1` | `NPM_FLOOR` |
| The lowest Node of the workflows | `22.18.0` | `NODE_FLOOR` |
| The security mailbox | `security@authtempo.com` | `SECURITY.md` |

The released packages are the fixed group of `.changeset/config.json`. Every released package has the same version.

- `@authtempo/adapter-d1`
- `@authtempo/adapter-mysql`
- `@authtempo/adapter-postgres`
- `@authtempo/adapter-sqlite`
- `@authtempo/astro`
- `@authtempo/breach-check`
- `@authtempo/captcha-turnstile`
- `@authtempo/cli`
- `@authtempo/client`
- `@authtempo/compat-better-auth`
- `@authtempo/core`
- `@authtempo/express`
- `@authtempo/fastify`
- `@authtempo/handoff`
- `@authtempo/hono`
- `@authtempo/import`
- `@authtempo/legacy-hashes`
- `@authtempo/mcp`
- `@authtempo/next`
- `@authtempo/observe`
- `@authtempo/react`
- `@authtempo/react-router`
- `@authtempo/solid`
- `@authtempo/sveltekit`
- `@authtempo/tanstack-start`
- `@authtempo/verify`
- `@authtempo/vue`

## Once, before the first release

Do these steps in this order, before step 1 of "At each release". Step 8 of "At each release" adds the trusted publishers, and it needs the environment of step 4.

1. Create the npm organization `authtempo` on npmjs.com, with your account as the owner. Without it, npm refuses each `@authtempo` name, and the job `publish` fails.
2. WARNING: Read the whole git history for secrets before you make the repository public. A public history cannot become private again, because each clone and each fork keeps a copy. Read the output of `git log --all -p` for a key, a token, or a password. The records also hold local machine paths with a user name, such as the plan files under `docs/superpowers/plans/`. Each commit names its author too. A record is append-only, so these stay. Decide whether they may be public before the change. Then make the repository `BirdTempo/authtempo` public. Without it, npm refuses the provenance of each tarball, and the job `publish` fails. The npm docs say: "Provenance generation is not supported for private repositories" (read 2026-10-30).
3. Protect the branch `main`. Require a pull request and the job `check` of `ci.yml`. Select "Do not allow bypassing the above settings", so the rule holds for administrators too. The GitHub docs name this setting (read 2026-10-30). Add the same rule for the branch name pattern "release/*", the branches of a patch of an older minor. Without it, a commit with no check reaches `main`, and `check-tag` accepts a tag on it. By default an administrator, such as you, can push past the rule. `check-tag` also accepts a tag on a release branch. So a push there with no check is a release source too.
4. Create the environment `release` in the settings of the repository. Add yourself as the required reviewer. Add a deployment rule that allows the tags `v*` only. Without it, GitHub makes the environment at the first run with no reviewer. The job `publish` then starts with no approval.
5. Add a tag ruleset for `v*` that lets only you create, move, or delete such a tag. Without it, a person with write access starts a release with a tag. GitHub runs `release.yml` from the tagged commit, so `check-tag` guards only what that commit holds.
6. Turn on private vulnerability reporting in the security settings of the repository. Without it, the first channel of `SECURITY.md` does not exist. A reporter then has no private way to report a fault.
7. Create the mailbox `security@authtempo.com`, and send one test mail to it. Without it, each report to the second channel of `SECURITY.md` bounces.
8. Confirm the license exemption of `postgres` 3.4.9 (Unlicense) in `release/license-exempt.json`, or add Unlicense to the allowed licenses. If you remove the entry and allow nothing, `check-dependencies` fails. The CLI depends on `postgres`.
9. Read the log of the first run of the job `check` of `ci.yml` on GitHub. No run has proven `scripts/test-servers.mjs` on a runner of GitHub: it needs Docker, `lsof`, tmpfs, and `mem_limit` there. Before the Turbo lines, find one line `Container authtempo-s<slot>-<service>-1 Healthy` for each service. The six services are `postgres`, `libsql`, `libsql-cli`, `libsql-cli-compat`, `mysql84`, and `mysql97`. If a service has no such line, or a line starts with `test-servers:`, stop and record the line. Without it, a fault of the runner looks like a fault of the code.

## At each release

1. On a clean checkout of `main`, run `pnpm install --frozen-lockfile`, then `pnpm release:check`. The check starts the test servers of the checkout through `scripts/test-servers.mjs`, so Docker must run. Without Docker, the adapter tests fail. If the check prints FAIL, stop. The job `check` of `release.yml` runs the same commands and fails at the same step.
   - Then write the planned values of this release in `release/rehearsal.json`. `publish` is the UTC time of step 4. `support` holds the rows of `release/support.json` after step 5. `resources` holds the rows of the Resources page of "The first release". The rehearsal reads this file from the checkout, so a change needs no commit.
   - Run `pnpm release:rehearse`. In a copy of the last commit, it runs `pnpm changeset version`, the rewrite of the first release, and the edits of steps 4 to 6. Then it runs `pnpm lint --error-on-warnings` in the copy, so a format fault or a warning fails the rehearsal. Then it runs `pnpm release:check --no-osv --no-dry-run` in the copy, as the job `check` of `ci.yml` runs it on the pull request. It prints one line, `release-rehearsal: PASS` or `release-rehearsal: FAIL`, and the failures below it. If it prints FAIL, stop. Fix what each failure line names: `main`, the plan values of `release/rehearsal.json`, or the changes of the checkout. Then run it again. Without it, the version pull request can fail its own check. At `0.1.0`, 46 tests and one site check failed that way. The dry run did not show it, because it runs no test.
2. Make the version branch: `git switch -c version/<version>`. Do not name it `release/<major>.<minor>`. `check-tag` keeps that name for a patch of an older minor.
3. Run `pnpm changeset version`. Read each version change and each new changelog section. If a section is wrong, discard the output of this step first, because the step deletes each changeset. Run `git restore .` and `git clean -f -- 'packages/*/CHANGELOG.md'`. Then change the changeset, and run this step again.
4. Add one row for each released package to `RELEASE_DATES` in `apps/site/src/data/releases.ts`. The key is `<name>@<version>`. The value is the planned UTC time of the publish in the form `YYYY-MM-DDTHH:MM:SSZ`, such as `2026-11-02T15:00:00Z`. Without it, `check-feed` fails the pull request, and the site build of `main` fails after the merge. Step 14 corrects a wrong day.
5. At a new minor, add its support row. In `release/support.json`, add the row of the minor with the status `current`. Write the UTC day of step 4 in `released`, and each supported schema version in `schemaFrom`. Set the row of the previous minor to `security`, with `securityUntil` 3 months after that day. Set each row past its `securityUntil` day to `unsupported`. Write the same rows in the table of the section "Supported versions" of `SECURITY.md`. Without it, `check-support` fails the pull request. At the first release, `check-security-policy` also fails after the edits of step 6. A patch keeps the table. Write the file in the form of `pnpm exec biome format`, because the job `check` of `ci.yml` runs `pnpm lint` and refuses another form.
6. At the first release only, do the edits of "The first release" below. Each edit has a check that fails until it is done.
7. Push the branch with `git push -u origin version/<version>`. Open the pull request, and wait for the job `check` of `ci.yml`. If it fails, fix the branch. Then merge it.
8. On npmjs.com, add a trusted publisher to each released package that has none. At the first release, that is each package. Without it, the job `publish` gets no npm token, and npm refuses each tarball.
   - Organization or user: `BirdTempo`. Repository: `authtempo`. Workflow filename: `release.yml`. Environment name: `release`.
   - Under Allowed actions, select `npm publish`. A configuration made after 2026-09-03 allows only `npm stage publish` by default, and the job `publish` then fails.
   - A new configuration expires when its first publish does not succeed within 2 days. So do this step after the merge of step 7, at most 2 days before the tag of step 9.
   - The job `publish` passes `--tag` to `npm publish`. On the day, read whether `--tag` also needs Allow npm dist-tag. The npm docs (read 2026-10-20 and 2026-10-30) say that dist-tag access is a separate action.
   - If npm offers no trusted publisher for a package with no version, stop. Record the answer of npm and the date. Go to "The token fallback".
   - These facts come from docs.npmjs.com/trusted-publishers, last edited 2026-10-06 and read 2026-10-30.
9. Tag the merge commit on `main` with `v<version>`, and push the tag. A tag on the version branch before the merge fails `check-tag`.
10. Wait for the job `check` of `release.yml`. Then approve the job `publish` in the environment `release`. After a new trusted publisher of step 8, approve it within 2 days of that step.
11. Wait until the job `publish` ends. Then run `node scripts/release/src/verify-published.ts <version>`, with the version of the tag. A run before the end reads a half release, and it sends you to "A failed publish" with no fault. Without the version, it reads the group version of the checkout, which differs for a patch of an older minor. It reads each released name from `.changeset/config.json`, and fails on a version with no provenance attestation on npm. It also fails an attestation of another repository or another workflow than `release.yml`. If it prints FAIL, stop, and read "A failed publish".
12. In a new empty folder, install `@authtempo/core` and `@authtempo/cli` at the new version, and run `npm audit signatures`. If it prints an invalid or a missing signature, stop. Do not compare its counts with the released packages: it counts each installed package, such as each dependency.
13. Run `npm view @authtempo/core@<version> authtempo --json`. If the output has no `breaking` key, `authtempo upgrade` stops for each app with exit 1. Then follow "A bad version", and release a patch.
14. Run `npm view @authtempo/core time --json`, and read the time of the new version. If its day differs from the rows of step 4, correct each row by a pull request. At a new minor, also correct the day `released` of step 5 in `release/support.json` and in `SECURITY.md`.
15. Append one dated evidence line to `docs/superpowers/plans/README.md`, on a new branch, and merge it by a pull request. The protection of `main` refuses a direct push. Name the version, the tagged commit, and the `verify-published` line. Also name the `release-dry-run` line of the step `Dry run the tarballs` of the job `check` of `release.yml`. That dry run reads the tarballs that npm receives. So its line names the version of the tag, such as `version=0.1.0` at `v0.1.0`. Do not copy the `release-dry-run` line of `pnpm release:check` in the same job. That dry run versions a copy to the next minor.
16. Publish the site: run `pnpm turbo run build --filter=@authtempo/site --force`, then `pnpm --filter @authtempo/site exec wrangler deploy`. Without the build, the deploy guard refuses the folder `dist`. The hold of 2026-10-11 stays until you lift it.

Do not run `authtempo init` from the version branch between step 3 and the end of the job `publish`. Do not run it from `main` between the merge of step 7 and the end of the job `publish` either. In that time the scaffold names a version that is not on npm yet, and the texts of `PRE_RELEASE_SENTENCES` and `UNPUBLISHED_FILES` have their published form. A failed publish keeps that state until the rerun, and the token fallback keeps it until its reviewed change.

The commands of steps 9, 11, and 12:

```sh
git switch main && git pull --ff-only
git tag v0.1.0 && git push origin v0.1.0

node scripts/release/src/verify-published.ts 0.1.0

cd "$(mktemp -d)"
npm init -y
npm install @authtempo/core@0.1.0 @authtempo/cli@0.1.0
npm audit signatures
```

Write the real version in place of `0.1.0`.

### The first release

The version pull request of `0.1.0` also makes these edits. Each check fails until its edit is done.

- Run `node scripts/release/src/rewrite-unpublished.ts`. It replaces each note of `UNPUBLISHED_FILES`, each note line of `PAGE_NOTES` on the pages of `UNPUBLISHED_PAGES`, and each text of `PRE_RELEASE_SENTENCES` with its published text. It also removes the section "The versions today" of the versioning page. If it prints FAIL, it writes no file. Then correct the list in the code, and run it again. Without it, `check-pack`, `check-unpublished`, `check-policy-pages`, and `check-pre-release` fail. `check-security-policy` also fails, because after step 5 `SECURITY.md` still says that the channels are not open.
- Then run `pnpm format`, and commit its result with the other edits. A rewritten cell of `apps/site/src/data/compare.ts` can pass the line width of Biome. Without the format, `pnpm lint` of `ci.yml` fails the pull request. A later release has no format step.
- Read each changed file. The script changes only the listed texts. Correct the text around a note by a commit when it still names the clone.
- `check-resources`: in `apps/site/src/content/docs/docs/resources.md`, remove the sentence `RESOURCES_EMPTY`. Add one row for each released package, one row for each example folder, and one row for the demo. A package row links `https://www.npmjs.com/package/<name>`. An example row links `https://github.com/BirdTempo/authtempo/tree/main/examples/<folder>`. The demo row links `/demo/`. The `resources` lines of `release/rehearsal.json` hold these rows for `0.1.0`. The script leaves this text.
- `check-support` and `check-security-policy`: step 5 adds the row of the first minor to `release/support.json`. Write its table in `SECURITY.md` in the place of the first text below, which the script leaves. The forms are below.
- `check-pre-release`: in `apps/site/src/content/docs/docs/reference/routes.md`, do the owner check of `POST /social/:provider/id-token` on a real device. If a check fails, stop the release. Then remove the paragraph and its three steps, the last text below. The script leaves this text.

The texts of `PRE_RELEASE_SENTENCES`, each under its file:

```text
SECURITY.md
  No release exists yet. The first minor is the current minor at its release.
  Until the first release, the two channels are not open, and the times of this policy do not apply.
apps/site/src/content/docs/docs/reference/security-policy.md
  Until the first release, the two channels are not open, and the times of this policy do not apply.
apps/site/src/content/docs/docs/versioning.md
  Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.
  No release exists yet. The first minor is the current minor at its release.
apps/site/src/content/docs/docs/changelog.mdx
  Until the first release, the plan index of the repo is the record of each change: `docs/superpowers/plans/README.md`. Each row names a plan, its spec sections, and the commit that merged it.
apps/site/src/content/docs/docs/resources.md
  No release exists yet, so no package, example, or demo is published; this page lists them from the first release.
apps/site/src/data/compare.ts
  No release yet.
  No release notes yet.
README.md
  The packages are not on a registry yet.
  After the first release: `pnpm add @authtempo/core @authtempo/adapter-d1`, then `npm audit signatures`.
apps/site/src/content/docs/docs/migrate/better-auth.mdx
      "better-auth": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/drizzle-adapter": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/expo": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/passkey": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/api-key": "npm:@authtempo/compat-better-auth@0.0.0",
      "@authtempo/core": "0.0.0",
      "@authtempo/client": "0.0.0",
      "@authtempo/handoff": "0.0.0",
      "@authtempo/adapter-d1": "0.0.0",
      "@authtempo/adapter-postgres": "0.0.0"
packages/compat-better-auth/README.md
      "better-auth": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/drizzle-adapter": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/expo": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/passkey": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/api-key": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/sso": "npm:@authtempo/compat-better-auth@0.0.0",
      "@better-auth/scim": "npm:@authtempo/compat-better-auth@0.0.0",
      "@authtempo/core": "0.0.0",
      "@authtempo/client": "0.0.0",
      "@authtempo/handoff": "0.0.0",
      "@authtempo/adapter-d1": "0.0.0",
      "@authtempo/adapter-postgres": "0.0.0"
apps/site/src/content/docs/docs/reference/routes.md
  Owner check before the first release with this route. Core's tests use test keys, not real tokens. Run these checks on a real device:

  1. Sign in once with Google One Tap. Give it `providerNonce`, and confirm that the token's `nonce` claim is that value.
  2. Sign in once with the native Apple sheet. Give it `providerNonce`, and confirm that the token's `nonce` claim is that value.
  3. On the Apple token, confirm that `exp` minus `iat` is 86400 seconds or less. Core refuses a token with a longer life.
```

The row of the first minor in `release/support.json`. Write the UTC day of the publish in `released`, and `SCHEMA_VERSION` of `packages/core/src/schema.ts` in `schemaFrom`:

```json
[{ "minor": "0.1", "status": "current", "released": "2026-11-02", "schemaFrom": [15] }]
```

The table of the section "Supported versions" of `SECURITY.md`, in the place of its first text above:

```text
| Minor | Status | Released | Security fixes until | Schema versions |
| --- | --- | --- | --- | --- |
| 0.1 | current | 2026-11-02 | none | 15 |
```

### The token fallback

This branch is a stop: it needs a reviewed change before any publish. `check-workflows` refuses a token in a workflow, so do not add one to `release.yml` by hand.

- The fallback is one first publish with a granular npm token that expires after one day. Then add the trusted publishers, and revoke the token.
- This is the one publish by hand; every other publish goes through the workflow. Take the tarballs of the job `check`. Compare each SHA-256 with `SHA256SUMS`, and run `node scripts/release/src/check-pack.ts` on each tarball first.
- Publish each tarball after the tarballs of its dependencies, so core goes first. Use `npm publish <tarball> --access public --provenance=false` for each tarball.
- A tarball holds `publishConfig.provenance` true, and npm takes the flag of the command over `publishConfig` (npm 11.19.1, `lib/commands/publish.js`, read 2026-10-30). Without the flag, npm asks for provenance outside CI, and the publish fails.
- A version that you publish this way has no attestation. Add one entry for each package that you publish this way to `release/fallback-published.json` by a pull request. The key of an entry is `<name>@<version>`, so one entry passes one package only. Without the entry, `verify-published` fails at step 11. One entry has this form, with the UTC day of the publish in the form `YYYY-MM-DD`:

```json
[{ "package": "@authtempo/core@0.1.0", "date": "2026-11-02", "reason": "npm offered no trusted publisher for a package with no version." }]
```

## Once, after the first publish

1. On npmjs.com, open the settings of each released package. Under Publishing access, select "Require two-factor authentication and disallow tokens". Without it, a stolen token can publish a version.
2. If you used the token fallback, revoke the token. Without it, the token stays valid until its expiry.

## A failed publish

- Rerun the failed jobs of the same run, on the same tag. The job `publish` skips each version that the registry already holds, so it publishes only the rest.
- On the day, read the GitHub docs on a rerun and on the retention of artifacts. A rerun of the job `publish` needs the artifact `tarballs` of the job `check`.
- The registry can show a new version some minutes late. If the rerun stops on a version that exists, wait, and run it again.
- Do not move or delete the tag. Do not publish by hand: "The token fallback" is the one publish by hand.

## A bad version

- Run `npm deprecate @authtempo/<name>@<version> "<reason>"` for each released package. Write the reason and the fixed version in the text.
- Then release a patch with the fix, by the steps of "At each release".
- Never run `npm unpublish`. An app that pins the version then fails its install, and npm never accepts the same version again.
- For a security fault, also follow `SECURITY.md`: an advisory, and a "Security:" line in the changeset of the fix.

## What the checks do not prove

- No CI job runs the floor of Node. `ci.yml` and `release.yml` run Node 26.10.0 only. The floor is 22.13 for `@authtempo/cli`, `@authtempo/mcp`, `@authtempo/compat-better-auth`, `@authtempo/import`, and `@authtempo/adapter-sqlite`. It is 22 for the other packages.
- So a package can use a Node API that is newer than its floor, and every check still passes. An app on the floor then fails at load or at run time. A CI job on the floor is a follow-up of plan 12j.
- Two paths stay outside the code: an edited tagged commit, and the publish by hand of "The token fallback". Steps 3, 4, and 5 of "Once, before the first release", step 8 of "At each release", and `verify-published` are the guards.
