# Contributing to authtempo

This file tells you how to build and test authtempo, and the rules that each change keeps. To report a fault, use a channel of [`SECURITY.md`](SECURITY.md). Do not open a public issue for a fault.

## Build

You need Node 22.18.0 or newer, pnpm 12.8.1, and Docker. The scripts of the repository are `.ts` files, and Node strips their types from 22.18.0.

```sh
pnpm install --frozen-lockfile
pnpm build
```

## Test with the cache off

Run every test and every type check with the cache off, through the test servers of your checkout:

```sh
node scripts/test-servers.mjs run -- pnpm turbo run test typecheck typecheck:configs --force --continue --log-prefix=task
node scripts/test-servers.mjs down
```

`scripts/test-servers.mjs` starts a set of servers in Docker for your checkout, and gives each test its address. Without it, each test that needs a server stops with "not set". Run `down` at the end, so the set stops. `pnpm release:check` runs the same command.

The summary of Turbo must show `0 cached`. A cache is a tool for speed. It is never evidence that the code works, because a cached task did not run on your change.

## The evidence rule

- A test run is evidence only when its Turbo summary shows `0 cached`.
- Read each count from its summary line. Do not count the failure lines.
- Count the packages that reported. A package that did not run looks the same as a package that passed.
- Prove each new test with a break. Break the code that the test covers, see the test fail, restore the code, and see the test pass.
- Do not write a fixture of a state that the product cannot get to. Such a fixture hides the fault that the test must find.
- Do not write a test that asserts the current wrong behavior. Correct the code.

## The records rule

These files are records, and they are append-only:

- each `CHANGELOG.md`
- the advisory record `docs/security/advisories.md`
- each shipped migration file
- the release evidence `docs/release/EVIDENCE.md`
- the versioning rules `docs/release/versioning-rules.md`

Do not edit the text of a record. A fault in an old entry gets a dated correction in a new entry. `check-records` holds the changelogs, the advisory record, and the migrations.

## The commit shape

- Write a one-line subject in the imperative, in Simplified Technical English, under 72 characters.
- Write one changeset for each change to a released package. Run `pnpm changeset`, and read `.changeset/README.md` for the rules.
- Run `pnpm lint` before the commit. It must show no error and no warning.

```sh
pnpm changeset
pnpm lint
```

## No publish

Do not publish. Only the owner publishes, by `docs/release/RUNBOOK.md`. Do not run `npm publish`, `pnpm publish`, or `changeset publish`. The release workflow publishes a release only after the owner approves it.
