---
title: Choose your stack
description: Pick the runtime and the database for authtempo, and find the tutorial for that pair.
type: tutorial
sources:
  - README.md "Packages"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 4
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 14
sidebar:
  order: 1
---

**For:** a developer who starts with authtempo and must choose where it runs.

**What it does:** this page compares the four stacks and sends you to the tutorial of one.

## Before you start

- Know where your API runs: Cloudflare Workers, Node, or Bun. [Runtimes and compatibility flags](/docs/reference/runtimes/) lists what each needs.
- Know which database your app has, or will have. [Schema and migrations](/docs/reference/schema/) covers D1 and Postgres.

## Steps

1. Find your runtime and your database in the table.
2. Open the tutorial of that row, and do every step.
3. Then do [Your first sign-in from a web app](/docs/start/first-sign-in/).

| Stack | Storage adapter | Node.js compatibility | Example app | Tutorial |
| --- | --- | --- | --- | --- |
| Workers on D1 | `@authtempo/adapter-d1` | Off: `no_nodejs_compat` | `examples/worker-d1` | [Workers on D1](/docs/start/workers-d1/) |
| Workers on Postgres | `@authtempo/adapter-postgres` through Hyperdrive | On: `nodejs_compat` | `examples/worker-postgres` | [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/) |
| Node | `@authtempo/adapter-postgres` | Not a Workers setting | `examples/node` | [Node](/docs/start/node/) |
| Bun | `@authtempo/adapter-postgres` | Not a Workers setting | `examples/node`, run by Bun | [Bun](/docs/start/bun/) |

## The packages today

The `@authtempo` packages are private and at version `0.0.0`. They are not on a registry yet, and the owner decides when they publish. Until then, put your app in the pnpm workspace of the repo, in a folder under `examples/`. The `workspace:*` versions then link the packages, and Turbo builds them before your tests.

| Package | Role |
| --- | --- |
| `@authtempo/core` | The engine. `createAuth(config)` answers `handle`, `session`, `caller`, and `api`. |
| `@authtempo/adapter-d1` | The storage on Cloudflare D1, with its migrations and an owned limiter. |
| `@authtempo/adapter-postgres` | The storage on Postgres through postgres.js, with its migrations and an owned limiter. |
| `@authtempo/client` | The app side: `createClient` calls the routes and answers typed results. It runs in a browser, in Expo, and in Electron. |
| `@authtempo/handoff` | The sign-in of a native or desktop app through the system browser. |
| `@authtempo/compat-better-auth` | Runs an app written for Better Auth 1.7 on authtempo, on its own tables. |
| `@authtempo/legacy-hashes` | Verifies the password hashes of other systems and rewrites them as PBKDF2. |
| `@authtempo/import` | The `authtempo-import` command, which moves users from another provider. |

## What each stack costs

- A password hash needs more CPU than Workers Free gives one request. A Worker with passwords needs Workers Paid.
- D1 has no interactive transaction. A transaction on D1 is not isolated from other requests. [The race rules](/docs/concepts/races/) tell what that means.
- On Workers the Postgres client has one connection for each request. Read [The one-connection rule](/docs/concepts/one-connection/) before you add a hook.
- Off Workers, the server must give core the client IP. The Node example sets a header from the socket, and core reads only that header.

## Next

- [Workers on D1](/docs/start/workers-d1/)
- [Node](/docs/start/node/)
- [Your first sign-in from a web app](/docs/start/first-sign-in/)
