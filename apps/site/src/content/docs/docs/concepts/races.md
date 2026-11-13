---
title: The race rules
description: How core stays right when two requests touch the same rows at the same moment, on D1 and on Postgres.
type: explanation
sources:
  - packages/adapter-d1/README.md "Transactions"
  - packages/core/README.md "Limits"
---

**For:** a developer who writes an adapter, a hook, or SQL of their own on the tables of authtempo.

**What it does:** this page explains the guards that core uses instead of locks, and the windows that stay open.

## Before you start

- Read [The storage port](/docs/concepts/storage-port/) for `transaction` and the `where` clauses.

## The problem

Two requests can read the same row and then both write. On Postgres a transaction runs at read committed. On D1 a transaction is not isolated at all: the adapter runs each statement at once and keeps an undo log. Core must stay right on both.

## The guards

Core does not depend on the isolation of a transaction. It uses three guards that every adapter keeps.

- **The conditional update.** A spend is one `update` with a `where` that names the state it expects, such as `consumedAt is null`. The database runs it as one statement. Of two requests, one updates one row and the other updates zero rows. A magic link, a code, a challenge, and a refresh token are each spent this way.
- **The unique key.** Two creates of the same value leave one row. The loser gets `unique_violation`, reads the winner's row, and goes on with it. Find-or-create of a user and the first signing key work this way.
- **The compare-and-set.** The port has no increment. A count of wrong guesses matches the row by id and by the `updatedAt` that it read, and writes a later `updatedAt`. A guess that loses reads the row again and counts on the new value. No guess goes uncounted, on D1 and on Postgres.

## The re-check at the end

A sign-in of any user can race with a claim of the same address. Each sign-in that trusts a row of the claim ends its transaction with a guard. The guard is a conditional update of that row. When a claim deleted or changed that row, the update matches zero rows. The sign-in then deletes its own session and answers a failure. A password sign-in also re-checks its password row by id and by the hash that it verified. So a reset or a change in between wins.

## The rehash race

Two right password sign-ins can both try to rehash one row. One update wins. The loser reads the row again, verifies the password against the new hash, and goes on. Both sign-ins succeed.

## Counts under a lock

On Postgres every cap and every organization limit counts after a row lock, so a second create waits for the first commit. The cap of 50 API tokens and `perUser` count after the hold of the user row. The cap of 50 organization tokens, `dynamicRoles.maxPerOrganization`, `membersPerOrganization`, `pendingInvitationsPerOrganization`, and `teamsPerOrganization` count after the lock of the organization row. `membersPerTeam` counts after the lock of the team row. D1 is the one exception.

## What stays open

- **Counts on D1.** Each cap and each organization limit is a count before the create. D1 has no lock, so two creates at the same moment can both pass at the limit minus one. For API tokens, the limit of 20 creates per user per hour bounds the overshoot.
- **A dead isolate on D1.** The undo log lives in memory. An isolate that stops during a transaction never rolls back, and the writes before the stop stay.
- **A lost answer on D1.** D1 can apply a write and lose its answer. The write stays, and the undo log holds no entry for it. A claim calls `undoOnlyWhile` after its lease, so the undo puts a deleted row back only while the user is unverified. After a lost answer at the mark of the address, the user stays verified, and no row of the claimant comes back. The flow answers 500, and the owner's next proof signs in. The claim's session delete did not run, so the claimant's sessions stay. Each came before the proof, so it ends at its next use, with the reason `claimed`. The claim is final at its mark of the address. So a failure after the mark, such as at the session delete, also leaves the user verified. No row of the claimant comes back, and each session that stays ends at its next use. So a lost answer leaves the claimant no credential and no way in.
- **A claim past its lease on D1.** A claim whose statements run past 60 seconds can meet a rival claim. The rival took its lease, or a new lease after the sweep. Each delete of a claim calls `deleteOnlyWhile`, so it deletes only while the user is unverified. After the rival's mark the late claim deletes nothing, and the owner keeps the rows that the rival kept. The undo of a claim's deletes also needs the claim's own lease, as the claim wrote it. The rival's take or the sweep changed that lease. So the undo of a late claim puts back no row, before or after the rival's mark. So the claimant keeps no credential.
- **A cascade on D1.** A foreign key with `ON DELETE CASCADE` deletes child rows inside SQLite, so the undo log holds no entry for them. Core's tables have no foreign key. Code of your own on the Better Auth tables must delete the child rows first.
- **Two invitations.** Two invites for one address at the same moment can leave two pending invitations. The pair of organization and address is an index, not a unique key. On Postgres with `pendingInvitationsPerOrganization` on, the lock of the count runs the two one at a time, and one stays.

## Next

- [The storage port](/docs/concepts/storage-port/)
- [The one-connection rule](/docs/concepts/one-connection/)
- [Write a storage adapter](/docs/guides/adapter/)
