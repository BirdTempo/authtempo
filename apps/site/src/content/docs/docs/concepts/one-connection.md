---
title: The one-connection rule
description: Why a before hook must not query core's Postgres client while its pool has one connection, and what to do instead.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.9
  - packages/adapter-postgres/README.md "On Cloudflare Workers"
  - packages/core/README.md "Hooks"
  - packages/compat-better-auth/README.md "Hooks"
---

**For:** a developer who writes a hook on Postgres, and above all on Workers through Hyperdrive.

**What it does:** this page explains one hang that a hook can cause, and the three ways to avoid it.

## Before you start

- Read [Run your code at a flow point](/docs/guides/hooks/) for the before hooks and the after hooks.
- Read [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/) for the client of one connection.

## The setup

On Workers, the Postgres client of each request has one connection: `max: 1`. A transaction holds that connection from `BEGIN` to `COMMIT`.

A before hook runs inside the flow's transaction, before the first write. Core waits for the hook to settle before it goes on.

## The hang

1. Core opens a transaction, which takes the one connection.
2. Core calls the before hook and waits.
3. The hook runs a query on the same client.
4. The query waits for a free connection.
5. No connection comes free, because the transaction waits for the hook.

The request hangs until the client ends. postgres.js has no default queue timeout. No error names the cause.

## The ways out

- **A second connection.** Give the hook a pool of two or more, or a separate client. The hook's query then runs on its own connection.
- **The after hook.** Write the app's row from the after hook, after the commit. A failed write there leaves the core row without the app's row, and core logs the failure.
- **D1.** On D1 a write through the binding is a separate request and takes no lock, so the hang cannot occur.

A before hook must also not open a transaction on core's storage. It runs inside one already.

## Why core does not stop it

Core sets no timeout on a hook, as it sets none on the mail port. The rule stays with the app, and the adapter README states it beside the setting.

## Next

- [Run your code at a flow point](/docs/guides/hooks/)
- [The race rules](/docs/concepts/races/)
- [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/)
