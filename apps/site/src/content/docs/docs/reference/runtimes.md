---
title: Runtimes and compatibility flags
description: The runtimes that authtempo runs on, the Workers flags of each package, and what each runtime needs from the app.
type: reference
sources:
  - README.md "Rules that the code enforces"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 4
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 13
  - examples/worker/wrangler.jsonc
---

**For:** a developer who picks a runtime, or an operator who writes a `wrangler.jsonc`.

**What it does:** this page lists each runtime, the packages that run on it, and the flags and settings that each needs.

## Before you start

- Read [Choose your stack](/docs/start/) for the four stacks with a tutorial each.

## The runtimes

| Runtime | Version | Storage | Tutorial |
| --- | --- | --- | --- |
| Cloudflare Workers | compatibility date `2026-09-30` | D1, or Postgres through Hyperdrive | [Workers on D1](/docs/start/workers-d1/), [Workers on Postgres](/docs/start/workers-hyperdrive/) |
| Node | 22 or newer | Postgres | [Node](/docs/start/node/) |
| Bun | 1.4.3, the tested version | Postgres | [Bun](/docs/start/bun/) |

## The Workers flags

Workers turn Node.js compatibility on by default from compatibility date 2026-08-04.

| Package | The flags | Why |
| --- | --- | --- |
| `@authtempo/core` | `no_nodejs_compat`, `no_nodejs_compat_v2` | Core imports no `node:` module. The flags prove it on each deploy. |
| `@authtempo/adapter-d1` | `no_nodejs_compat`, `no_nodejs_compat_v2` | The same. |
| `@authtempo/compat-better-auth` on D1 | `no_nodejs_compat`, `no_nodejs_compat_v2` | The same. |
| `@authtempo/legacy-hashes` | `no_nodejs_compat`, `no_nodejs_compat_v2` | Its vectors run in a proof Worker with both flags. |
| `@authtempo/adapter-postgres` | `nodejs_compat` | postgres.js needs the Node modules of sockets. |

- The example Worker bundles itself in its test, and fails on any `node:` import.
- The vitest pool of Workers turns Node.js modules on for its own runner. A test in the pool cannot show a `node:` import. Only the bundle check shows it.
- The import CLI runs on Node.

## What each runtime needs

- **Workers:** the default `clientIp` reads `cf-connecting-ip`, which Cloudflare sets. A password hash needs Workers Paid, because one hash needs more CPU than Workers Free gives one request.
- **Workers with Hyperdrive:** make one postgres.js client for each request with `max: 1`, `prepare: false`, and `fetch_types: false`. End it in `ctx.waitUntil`.
- **Node and Bun:** pass `clientIp`. Without it, a caller sets `cf-connecting-ip` and passes any per-IP limit.
- **Node and Bun:** core uses Web Crypto and the Fetch API of the runtime. Serve `auth.handle` from a server that gives it a `Request`.

## Next

- [Choose your stack](/docs/start/)
- [Deploy](/docs/operations/deploy/)
- [The architecture](/docs/concepts/architecture/)
