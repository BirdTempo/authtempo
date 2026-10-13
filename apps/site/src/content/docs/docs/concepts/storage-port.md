---
title: The storage port
description: The six storage methods that core calls, the rules that every adapter keeps, and why the port is so narrow.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 6
  - packages/core/README.md "The storage port"
  - packages/adapter-d1/README.md "Transactions"
  - packages/adapter-postgres/README.md "Transactions"
---

**For:** a developer who writes an adapter, or who must know what core asks of a database.

**What it does:** this page explains the port between core and the database.

## Before you start

- Read [Architecture](/docs/concepts/architecture/) for the place of the port.

## The methods

The port is generic. Core names a model and its fields. The adapter maps them to tables and columns.

| Method | What it does |
| --- | --- |
| `create` | Writes one row and answers it. |
| `findOne` | Answers the first row that matches, or null. |
| `findMany` | Answers the rows that match, with an optional sort and limit. |
| `update` | Writes the fields to every row that matches, and answers the count. |
| `delete` | Deletes every row that matches, and answers the count. |
| `transaction` | Runs a function with a port whose writes commit together. |

## The rules

- Clauses join with AND only. There is no OR and no join. When core needs two tables, it does two reads.
- The operators are `eq`, `ne`, `in`, `lt`, `lte`, `gt`, and `gte`.
- `update` and `delete` take a `where`, never a bare id. So core can say "spend this token only if it is not spent" in one statement.
- An empty `in` list matches nothing. An empty `where` on `update` or `delete` is an error.
- Two null values never conflict on a unique key.
- Reads inside a transaction see the transaction's own writes.
- A sort takes one key or a list of keys, each with its own direction.
- The field types are string, boolean, integer, date, and json.

## Why so narrow

A narrow port is easy to keep on every database. D1 has no interactive transaction, and SQLite and Postgres differ in their types. Each method maps to one SQL statement, so an adapter has little room to differ from another.

The guards of core live in the `where` clauses and the unique keys, not in the isolation of a transaction. So the same guard works on D1 and on Postgres. [The race rules](/docs/concepts/races/) tell how.

## The contract

`runAdapterConformance` from `@authtempo/core/conformance` is the contract. It runs the same tests on every adapter: the operators, the sorts, the unique keys, the transactions, and the round trip of every model. An adapter that fails it does not ship.

## The schema version

The schema is one typed object in core, and its version is a constant. Each adapter ships one migration per version. An adapter refuses to run on a database with an older version. [Schema and migrations](/docs/reference/schema/) lists the versions.

## Next

- [Write a storage adapter](/docs/guides/adapter/)
- [The race rules](/docs/concepts/races/)
- [Schema and migrations](/docs/reference/schema/)
