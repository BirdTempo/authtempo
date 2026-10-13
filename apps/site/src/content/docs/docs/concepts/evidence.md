---
title: The evidence rules
description: What counts as proof that authtempo works, and the rules that keep a green run from hiding a missing test.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 11
  - README.md "Commands"
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 12"
---

**For:** a contributor to authtempo, or a reviewer who must decide whether a change is fit to ship.

**What it does:** this page explains how the repo proves a claim, and why each rule exists.

## Before you start

- Read the "Commands" table of the root `README.md` for `pnpm test` and the other commands.

## A green result is a claim

A test run that prints PASS says that the tests that ran passed. It does not say which tests ran. A suite that did not load, a package that did not report, and a step that did not run all look like a pass. So the repo checks what ran, not only what passed.

## The rules

- **The cache is off for tests.** Turbo never answers a test task from its cache. A cache is a speed tool, not evidence.
- **Count what reported.** The evidence run lists each package that must report a test summary. A missing summary is a failure.
- **Read the summary line.** A failure count comes from the summary line of a run, never from a count of the failure lines.
- **A check fails at zero.** A check that reads zero pages, links, samples, codes, or routes fails. A check that reads nothing looks the same as a pass.
- **Build before you read the build.** A check that reads build output builds it in the same command. An old build proves nothing about a new change.
- **Record the conditions.** A measurement names the machine, the date, and the load beside it.

## Tests must be able to fail

Each new test is proved by a break. The author breaks the code that the test covers, watches the test fail, and restores the code. A test that cannot fail gives false confidence, so it does not merge. Each plan names the break for each test.

Two more rules keep a test honest:

- A test never seeds a state that the product cannot reach. A fixture with an impossible row hides the defect it was written to catch.
- A test never asserts the current wrong behavior. The code is fixed instead.

## Where each proof runs

- The engine tests run on the memory adapter with an injected clock.
- The conformance suite of the storage port runs on D1 through the Workers test pool, and on Postgres through a local container.
- The end-to-end tests run the example Worker in workerd.
- The proofs that the Workers test pool cannot give run outside it. A bundle check fails on any `node:` import, because the pool turns the Node.js modules on for its own runner.

## Records are append-only

The spec, the plan index, and the plans are records. A change adds a dated line. A rule that would need an edit of a record to pass is the wrong rule.

## Next

- [Seams and dependencies](/docs/concepts/seams/)
- [Versioning policy](/docs/versioning/)
- [Architecture](/docs/concepts/architecture/)
