# Release runbook

This runbook holds the steps of the owner for a release of the authtempo packages (spec 33 item 4.3). Only the owner runs these steps. The loop of plan 12j never publishes, tags, or pushes.

Each step states what breaks without it. The test `scripts/release/test/runbook.test.ts` holds each value of this file to the code, and holds the order of the steps.

## The values

| Value | Text | Source in the code |
| --- | --- | --- |
| The repository | `https://github.com/BirdTempo/authtempo` | `release/repository.json` |
| The npm scope | `@authtempo` | `SCOPE` in `scripts/release/src/lib/release-facts.ts` |
| The release workflow | `release.yml` | `WORKFLOW_FILE` |
| The GitHub environment | `release` | `ENVIRONMENT` |
| The tag | `v<version>`, such as `v0.1.0` | `TAG_PREFIX` and `check-tag` |
| The first release | `0.1.0` | `FIRST_RELEASE` |
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

Do these steps in this order. The trusted publisher needs the environment, so step 9 comes after step 4.

1. Create the npm organization `authtempo` on npmjs.com, with your account as the owner. Without it, npm refuses each `@authtempo` name, and the job `publish` fails.
2. Make the repository `BirdTempo/authtempo` public. Without it, npm refuses the provenance of each tarball, and the job `publish` fails. The npm docs say: "Provenance generation is not supported for private repositories" (read 2026-10-30).
3. Protect the branch `main`. Require a pull request and the job `check` of `ci.yml`. Without it, a commit with no check reaches `main`, and `check-tag` accepts a tag on it.
4. Create the environment `release` in the settings of the repository. Add yourself as the required reviewer. Add a deployment rule that allows the tags `v*` only. Without it, GitHub makes the environment at the first run with no reviewer. The job `publish` then starts with no approval.
5. Add a tag ruleset for `v*` that lets only you create, move, or delete such a tag. Without it, a person with write access starts a release with a tag. GitHub runs `release.yml` from the tagged commit, so `check-tag` guards only what that commit holds.
6. Turn on private vulnerability reporting in the security settings of the repository. Without it, the first channel of `SECURITY.md` does not exist. A reporter then has no private way to report a fault.
7. Create the mailbox `security@authtempo.com`, and send one test mail to it. Without it, each report to the second channel of `SECURITY.md` bounces.
8. Confirm the license exemption of `postgres` 3.4.9 (Unlicense) in `release/license-exempt.json`, or add Unlicense to the allowed licenses. If you remove the entry and allow nothing, `check-dependencies` fails. The CLI depends on `postgres`.
9. On npmjs.com, add a trusted publisher to each released package. Use the values in the list below. Without it, the job `publish` gets no npm token, and npm refuses each tarball.
   - Organization or user: `BirdTempo`. Repository: `authtempo`. Workflow filename: `release.yml`. Environment name: `release`.
   - Under Allowed actions, select `npm publish`. A configuration made after 2026-09-03 allows only `npm stage publish` by default, and the job `publish` then fails.
   - A new configuration expires when its first publish does not succeed within 2 days. So do this step at most 2 days before the first tag.
   - The job `publish` passes `--tag` to `npm publish`. On the day, read whether `--tag` also needs Allow npm dist-tag. The npm docs (read 2026-10-20 and 2026-10-30) say that dist-tag access is a separate action.
   - If npm offers no trusted publisher for a package with no version, stop. Record the answer of npm and the date. Go to "The token fallback".

The facts of step 9 come from docs.npmjs.com/trusted-publishers, last edited 2026-10-06 and read 2026-10-30.

### The token fallback

This branch is a stop: it needs a reviewed change before any publish. `check-workflows` refuses a token in a workflow, so do not add one to `release.yml` by hand.

- The fallback is one first publish with a granular npm token that expires after one day. Then add the trusted publishers, and revoke the token.
- Never publish by hand. If a manual publish is the only way, take the tarballs of the job `check`. Compare each SHA-256 with `SHA256SUMS`, and run `node scripts/release/src/check-pack.ts` on each tarball first.
- A tarball that you publish from your computer has no provenance.

## At each release

1. On a clean checkout of `main`, run `pnpm install --frozen-lockfile`, then `pnpm release:check`. If it prints FAIL, stop. The job `check` of `release.yml` runs the same check and fails at the same step.
2. Make the version branch: `git switch -c version/<version>`. Do not name it `release/<major>.<minor>`. `check-tag` keeps that name for a patch of an older minor.
3. Run `pnpm changeset version`. Read each version change and each new changelog section. If a section is wrong, change its changeset and run the step again.
4. Add one row for each released package to `RELEASE_DATES` in `apps/site/src/data/releases.ts`. The key is `<name>@<version>`, and the value is the date of the tag in UTC. Without it, `check-feed` fails the pull request, and the site build of `main` fails after the merge.
5. At the first release only, do the edits of "The first release". Each edit has a check that fails until it is done.
6. Open the pull request, and wait for the job `check` of `ci.yml`. If it fails, fix the branch. Then merge it.
7. Tag the merge commit on `main` with `v<version>`, and push the tag. A tag on the version branch before the merge fails `check-tag`.
8. Wait for the job `check` of `release.yml`. Then approve the job `publish` in the environment `release`. At the first release, approve it within 2 days of step 9 above.
9. In a new empty folder, install each released package at the new version. Then run `npm audit signatures`. The count of verified attestations must equal the count of released packages.
10. Run `npm view @authtempo/core@<version> authtempo --json`. If the output has no `breaking` key, `authtempo upgrade` stops for each app with exit 1.
11. Append one dated evidence line to `docs/superpowers/plans/README.md`. Name the version, the tagged commit, the `release-dry-run` line, and the count of verified attestations.
12. Publish the site. The hold of 2026-10-11 stays until you lift it.

Do not run `authtempo init` from the version branch between step 3 and the end of the job `publish`. In that time the scaffold names a version that is not on npm yet. A failed publish keeps that state until the rerun.

The commands of steps 7 and 9:

```sh
git switch main && git pull --ff-only
git tag v0.1.0 && git push origin v0.1.0

mkdir /tmp/authtempo-audit && cd /tmp/authtempo-audit
npm init -y
npm install @authtempo/core@0.1.0 @authtempo/cli@0.1.0
npm audit signatures
```

Write the real version in place of `0.1.0`, and name each released package in the `npm install` line.

### The first release

The version pull request of `0.1.0` also makes these edits. Each check fails until its edit is done.

- `check-unpublished`: on each page of `UNPUBLISHED_PAGES` in `apps/site/src/data/unpublished.ts`, replace the note "not on a registry yet" with `REGISTRY_INSTALL`. Change the page text around it to the published form.
- `check-resources`: in `apps/site/src/content/docs/docs/resources.md`, remove the sentence `RESOURCES_EMPTY`. Add one row for each released package with its npm page, one row for each example folder, and one row for the demo at `/demo/`.
- `check-policy-pages`: in `apps/site/src/content/docs/docs/versioning.md`, remove the section "The versions today".
- `check-support` and `check-security-policy`: add the row of the new minor to `release/support.json` and to the table of `SECURITY.md`. Remove the two sentences that hold only before the first release, from `SECURITY.md` and from `apps/site/src/content/docs/docs/reference/security-policy.md`.

## Once, after the first publish

1. On npmjs.com, open the settings of each released package. Under Publishing access, select "Require two-factor authentication and disallow tokens". Without it, a stolen token can publish a version.
2. If you used the token fallback, revoke the token. Without it, the token stays valid until its expiry.

## A failed publish

- Rerun the failed jobs of the same run, on the same tag. The job `publish` skips each version that the registry already holds, so it publishes only the rest.
- On the day, read the GitHub docs on a rerun and on the retention of artifacts. A rerun of the job `publish` needs the artifact `tarballs` of the job `check`.
- The registry can show a new version some minutes late. If the rerun stops on a version that exists, wait, and run it again.
- Do not move or delete the tag. Never publish by hand. If a manual publish is the only way, run `node scripts/release/src/check-pack.ts` on each tarball first.

## A bad version

- Run `npm deprecate @authtempo/<name>@<version> "<reason>"` for each released package. Write the reason and the fixed version in the text.
- Then release a patch with the fix, by the steps of "At each release".
- Never run `npm unpublish`. An app that pins the version then fails its install, and npm never accepts the same version again.
- For a security fault, also follow `SECURITY.md`: an advisory, and a "Security:" line in the changeset of the fix.

## What the checks do not prove

- No CI job runs the floor of Node. `ci.yml` and `release.yml` run Node 26.10.0 only. The floor is 22.13 for `@authtempo/cli`, `@authtempo/mcp`, `@authtempo/compat-better-auth`, `@authtempo/import`, and `@authtempo/adapter-sqlite`. It is 22 for the other packages.
- So a package can use a Node API that is newer than its floor, and every check still passes. An app on the floor then fails at load or at run time. A CI job on the floor is a follow-up of plan 12j.
- Two paths stay outside the code: an edited tagged commit, and a manual publish with a token. The settings of steps 3, 4, 5, and 9 above, and the rule "never publish by hand", are the guards.
- The README of `@authtempo/cli` and six skills of `@authtempo/mcp` also hold the note "not on a registry yet". They ship in the tarballs. No check holds them yet.
