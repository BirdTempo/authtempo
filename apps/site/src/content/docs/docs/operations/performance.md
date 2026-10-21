---
title: Performance
description: Measured times of five operations of the example Worker on local D1, with the conditions of the run beside them.
type: reference
sources:
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 15"
  - apps/site/scripts/measure-performance.ts
  - examples/worker-d1/src/measure.ts
sidebar:
  order: 10
---

**For:** an operator who sizes a deployment, or a developer who compares the cost of the operations.

**What it does:** this page gives the measured times of five operations, and the conditions of the run that measured them.

## Before you start

- Read [Observability](/docs/operations/observability/). The server time of each call is the `durationMs` field of its `request` event.

## What is measured

The run starts the example Worker on D1 under `wrangler dev --local`, with the password config at the default PBKDF2 iterations. It measures five operations:

- `POST /password/sign-in`: a password sign-in. The PBKDF2 hash is most of its cost.
- `GET /session`: a read of the session of a cookie.
- `GET /token`: a session JWT for the session of a cookie.
- `GET /jwks`: the public key set of the session JWTs.
- `POST /magic-link/request`: a magic link mail to a known user. The mail port of the run writes the mail to the log.

Each operation gets calls to warm up, then the measured calls, one after another. Each call has its own client IP and turns through 50 users, so no limit refuses a call. A call that does not answer 2xx stops the run.

## The numbers

<!-- measured:start -->
<!-- measured:end -->

Local workerd is not a deployed Worker. A deployed Worker runs at the edge, near the user, on other hardware, with D1 over the network.

- The server time is the `durationMs` of the `request` event. The router reads the clock at the start and at the end of `handle`.
- On Workers the clock moves only at I/O. CPU work between two reads of storage can count as zero.
- The client time is the wall time of the call on the same machine. It includes the body of the answer.
- p50 and p95 are nearest-rank percentiles of the measured calls.

## Run it again

1. Commit each change. The run refuses a tree that is not clean, because the record names the commit.
2. Wait until the one-minute load is at most a quarter of the cores. The run refuses a higher load.
3. Run `pnpm --filter @authtempo/site run measure:performance`. The run writes `src/data/performance.json` and the block above.
4. Run the site checks. `check-performance` fails on a missing condition, a hand edit of the block, a loaded machine, or too few samples.

## Next

- [Observability](/docs/operations/observability/)
- [Limits](/docs/reference/limits/)
