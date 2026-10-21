---
title: Performance
description: Measured times of five operations of the example Worker on local D1, with the conditions of the run beside them.
type: reference
sources:
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 15"
  - apps/site/scripts/measure-performance.ts
  - apps/site/src/data/performance.json
  - examples/worker-d1/src/measure.ts
  - apps/site/src/data/observe-timing.json
  - packages/core/test/observer.test.ts
sidebar:
  order: 10
---

**For:** an operator who sizes a deployment, or a developer who compares the cost of the operations.

**What it does:** this page gives the measured times of five operations, and the conditions of the run that measured them.

## Before you start

- Read [Observability](/docs/operations/observability/). The server time of each call is the `durationMs` field of its `request` event.

## What is measured

The run starts the measure entry `examples/worker-d1/src/measure.ts` under `wrangler dev --local`, with the `wrangler.jsonc` of the D1 example. The measure entry differs from the shipped entry `src/index.ts` in three ways:

- It turns on the password config, at the default PBKDF2 iterations.
- Its outbox mail port writes each mail, with its link, to the log as one line.
- Its sink writes one extra line to the log for each request event, after the Workers Logs sink.

Do not deploy the measure entry. Its log holds the link of each mail. The `main` of `wrangler.jsonc` stays `src/index.ts`, and a site test holds it.

The run measures five operations:

- `POST /password/sign-in`: a password sign-in. The PBKDF2 hash is most of its cost.
- `GET /session`: a read of the session of a cookie.
- `GET /token`: a session JWT for the session of a cookie.
- `GET /jwks`: the public key set of the session JWTs.
- `POST /magic-link/request`: a magic link mail to a known user. The mail port of the run writes the mail to the log.

Each operation gets calls to warm up, then the measured calls, one after another. Each call has its own client IP and turns through 50 users, so no limit refuses a call. A call that does not answer 2xx stops the run.

## The numbers

<!-- measured:start -->
| Condition | Value |
| --- | --- |
| Date (UTC) | 2026-10-21T18:08:44.051Z |
| Commit | `eb530d6b78f3546fac526da12e5af53938891449` |
| Machine | Darwin 27.0.0, Apple M5 Max, 18 cores, 36 GiB of memory |
| Load before the run | 4.13, 10.36, 13.08 (1, 5, and 15 minutes) |
| Load after the run | 3.96, 10.22, 13.02 (1, 5, and 15 minutes) |
| Runtime | wrangler 4.148.0, local workerd, Node 26.10.0 |
| Storage | local D1 through Miniflare |
| PBKDF2 iterations | 100000 |
| Calls to warm up | 20 for each operation, not in the table |

All times are in milliseconds.

| Operation | Samples | Server p50 | Server p95 | Server max | Client p50 | Client p95 | Client max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /password/sign-in` | 200 | 8.0 | 9.0 | 11.0 | 8.9 | 10.6 | 12.0 |
| `GET /session` | 200 | 1.0 | 1.0 | 3.0 | 1.5 | 2.4 | 3.5 |
| `GET /token` | 200 | 1.0 | 2.0 | 4.0 | 2.3 | 3.6 | 6.5 |
| `GET /jwks` | 200 | 1.0 | 1.0 | 5.0 | 1.3 | 2.5 | 5.0 |
| `POST /magic-link/request` | 200 | 1.0 | 1.0 | 6.0 | 1.7 | 2.9 | 6.6 |
<!-- measured:end -->

Local workerd is not a deployed Worker. A deployed Worker runs at the edge, near the user, on other hardware, with D1 over the network.

- The server time is the `durationMs` of the `request` event. The router reads the clock at the start and at the end of `handle`.
- On Workers the clock moves only at I/O. CPU work between two reads of storage can count as zero.
- The client time is the wall time of the call on the same machine. It includes the body of the answer.
- p50 and p95 are nearest-rank percentiles of the measured calls.

## The observer timing run

An observer must not slow a sign-in. The timing test of core runs 5000 password sign-ins in one process, twice. The first run has a sink that never settles, and the second run has no observer. The test fails when the first median is more than 1.1 times the second median.

<!-- timing:start -->
| Condition | Value |
| --- | --- |
| Date (UTC) | 2026-10-21T19:06:02.000Z |
| Commit | `36da5bcdf0b55fe3c8180f7f70249e71c1677cd1` |
| Cores | 18 |
| Load before the run | 3.68, 9.12, 13.49 (1, 5, and 15 minutes) |
| Load after the run | 3.47, 8.99, 13.41 (1, 5, and 15 minutes) |
| Sign-ins in each run | 5000, after 20 to warm up |
| Median with a sink that never settles | 0.2530 ms |
| Median with no observer | 0.2403 ms |
<!-- timing:end -->

The medians come from one Node process with a fast test hash, not from workerd. They compare the two runs and give no time of a deployed sign-in.

## Run it again

1. Commit each change. The run refuses a tree that is not clean, because the record names the commit.
2. Wait until the one-minute load is at most a quarter of the cores. The run refuses a higher load.
3. Run `pnpm --filter @authtempo/site run measure:performance`. The run writes `src/data/performance.json` and the block above.
4. Run the site checks. `check-performance` fails on a missing condition, a hand edit of the block, a loaded machine, or too few samples.
5. For the timing run, wait until the one-minute load is at most a quarter of the cores. Then run `AUTHTEMPO_OBSERVE_TIMING=1 pnpm --filter @authtempo/core exec vitest run test/observer.test.ts --silent=false -t "does not slow a sign-in"`. Without `--silent=false`, vitest hides the line of the two medians when the test passes.
6. Write the two medians and the conditions to `src/data/observe-timing.json`, and change the timing block to match. `check-observe-timing` fails on a difference, a loaded machine, or a median above the bound.

## Next

- [Observability](/docs/operations/observability/)
- [Limits](/docs/reference/limits/)
