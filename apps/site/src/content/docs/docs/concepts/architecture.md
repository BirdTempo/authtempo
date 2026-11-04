---
title: Architecture and "own what you sell"
description: The parts of authtempo, how a request moves through them, and the rule that decides what authtempo owns.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 1
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 2
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 4
  - README.md "Packages"
---

**For:** a developer or an architect who must know how authtempo is built before they adopt it.

**What it does:** this page names the parts of authtempo and the rule behind them.

## Before you start

- Read [Choose your stack](/docs/start/) for the runtimes and the databases.

## The rule

authtempo is an authentication engine that the app owns. The engine, the flows, the tokens, the cookies, and the tables are its own code.

A small library may supply a primitive, such as a signature check. No library may be the only thing that keeps a promise. When a supplier changes, the product still does what it says.

## The parts

| Part | Package | What it does |
| --- | --- | --- |
| The engine | `@authtempo/core` | Runs every flow, owns the routes under `basePath`, and answers `handle`, `session`, `caller`, and `api`. |
| The storage port | `@authtempo/core` | Ten storage methods on model and field names. |
| The adapters | `@authtempo/adapter-d1`, `@authtempo/adapter-postgres` | Map the storage port to SQL, ship the migrations, and ship an owned limiter. |
| The client | `@authtempo/client` | Calls the routes from a browser, Expo, or Electron, and answers typed results. |
| The handoff | `@authtempo/handoff` | Signs a native or desktop app in through the system browser. |
| The compatibility package | `@authtempo/compat-better-auth` | Runs an app written for Better Auth 1.7 on the engine. |
| The importer | `@authtempo/import`, `@authtempo/legacy-hashes` | Moves users from another provider, and verifies their old password hashes. |

## A request

1. The app mounts `auth.handle` on a path prefix, `/auth` by default.
2. The router checks the method, the path, and the `Origin` header.
3. The route reads the body and calls one engine flow.
4. The flow checks the limits, reads and writes rows through the storage port, and answers a result.
5. The router writes the result as JSON, a redirect, or a page.

The app reads the signed-in user from its own routes with `auth.session(request)` or `auth.caller(request)`. Core has no framework dependency. It uses the standard `Request` and `Response` only.

## The ports

Core talks to the outside through ports that the app fills:

- The storage port holds the rows.
- The mail port sends each mail, such as a magic link, an email code, a reset link, an invitation.
- The limiter port counts the attempts per key and window.
- The clock gives the time, so a test can move it.

[Seams and dependencies](/docs/concepts/seams/) names the libraries behind the seams.

## The shape

Each app runs the engine in its own Worker or server, with its own database. No service is shared between apps. The design permits a hosted service later, but no hosted service exists.

## Next

- [The storage port](/docs/concepts/storage-port/)
- [Seams and dependencies](/docs/concepts/seams/)
- [The threat model](/docs/concepts/threat-model/)
