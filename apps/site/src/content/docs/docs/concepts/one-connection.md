---
title: The one-connection rule
description: Two hangs that a before hook can cause on Postgres, and how to avoid each.
type: explanation
sources:
  - packages/adapter-postgres/README.md "On Cloudflare Workers"
  - packages/core/README.md "Hooks"
  - packages/compat-better-auth/README.md "Hooks"
---

**For:** a developer who writes a hook on Postgres, and above all on Workers through Hyperdrive.

**What it does:** this page explains two hangs that a hook can cause, and the ways to avoid them.

## Before you start

- Read [Run your code at a hook point](/docs/guides/hooks/) for the before hooks and the after hooks.
- Read [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/) for the client of one connection.

## The setup

On Workers, the Postgres client of each request has one connection: `max: 1`. A transaction holds that connection from `BEGIN` to `COMMIT`.

A before hook runs inside the flow's transaction, before the first write. The one exception is a lock write: some flows lock a row before the hook, as [A second hang](#a-second-hang-the-flows-own-lock) tells. Core waits for the hook to settle before it goes on.

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

## A second hang: the flow's own lock

Some flows lock a row before their before hook, such as the user row of an organization create. [Locks over a before hook](/docs/guides/hooks/#locks-over-a-before-hook) lists each flow and its rows.

1. Core opens a transaction and locks the row.
2. Core calls the before hook and waits.
3. The hook awaits a core write of the same row, such as `auth.api.user.update` of the same user.
4. The write waits for the row lock.
5. The lock holds until the commit, and the commit waits for the hook.

This hang occurs with a pool of any size, because a second connection waits for the same lock. No error names the cause. A second connection is no way out here. Write from the after hook, or start the write with no `await` and catch its error. D1 has no row lock, so this hang cannot occur there.

## Why core does not stop it

Core sets no timeout on a hook, as it sets none on the mail port. The rule stays with the app, and the adapter README states it beside the setting.

## Next

- [Run your code at a hook point](/docs/guides/hooks/)
- [The race rules](/docs/concepts/races/)
- [Workers on Postgres through Hyperdrive](/docs/start/workers-hyperdrive/)
