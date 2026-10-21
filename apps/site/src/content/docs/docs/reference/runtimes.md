---
title: Runtimes and compatibility flags
description: The runtimes that authtempo runs on, the Workers flags of each package, and what each runtime needs from the app.
type: reference
sources:
  - README.md "Rules that the code enforces"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 4
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 13
  - examples/worker/wrangler.jsonc
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 28
  - packages/adapter-sqlite/README.md "Workers"
  - packages/adapter-mysql/README.md "Workers through Hyperdrive"
---

**For:** a developer who picks a runtime, or an operator who writes a `wrangler.jsonc`.

**What it does:** this page lists each runtime, the packages that run on it, and the flags and settings that each needs.

## Before you start

- Read [Choose your stack](/docs/start/) for the four stacks with a tutorial each.

## The runtimes

| Runtime | Version | Storage | Tutorial |
| --- | --- | --- | --- |
| Cloudflare Workers | compatibility date `2026-09-30` | D1, or Postgres through Hyperdrive. Also libSQL over `https:` or `libsql:`, and MySQL through Hyperdrive: each in a bundle proof, not a deploy. | [Workers on D1](/docs/start/workers-d1/), [Workers on Postgres](/docs/start/workers-hyperdrive/) |
| Node | 22 or newer | Postgres. SQLite through `node:sqlite` (Node 22.13 or newer), better-sqlite3, or libSQL. MySQL 8.4 or later. | [Node](/docs/start/node/), [SQLite](/docs/guides/sqlite/), [MySQL](/docs/guides/mysql/) |
| Bun | 1.4.3, the tested version | Postgres. SQLite through `bun:sqlite`. | [Bun](/docs/start/bun/), [SQLite](/docs/guides/sqlite/) |

## The Workers flags

Workers turn Node.js compatibility on by default from compatibility date 2026-08-04.

| Package | The flags | Why |
| --- | --- | --- |
| `@authtempo/core` | `no_nodejs_compat`, `no_nodejs_compat_v2` | Core imports no `node:` module. The flags prove it on each deploy. |
| `@authtempo/adapter-d1` | `no_nodejs_compat`, `no_nodejs_compat_v2` | The same. |
| `@authtempo/compat-better-auth` on D1 | `no_nodejs_compat`, `no_nodejs_compat_v2` | The same. |
| `@authtempo/legacy-hashes` | `no_nodejs_compat`, `no_nodejs_compat_v2` | Its vectors run in a proof Worker with both flags. |
| `@authtempo/adapter-postgres` | `nodejs_compat` | postgres.js needs the Node modules of sockets. |
| `@authtempo/adapter-sqlite` with libSQL | `no_nodejs_compat`, `no_nodejs_compat_v2` | The `libsql` entry and `@libsql/client/web` use `fetch`. A proof Worker bundles them with both flags. |
| `@authtempo/adapter-mysql` | `nodejs_compat` | mysql2 needs the Node modules of sockets. The package needs mysql2 3.24.5 or later. Hyperdrive needs 3.13.0 or later and `disableEval: true`. |

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
