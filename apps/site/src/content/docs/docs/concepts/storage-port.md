---
title: The storage port
description: The six storage methods that core calls, the rules that every adapter keeps, and why the port is so narrow.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 6
  - packages/core/README.md "The storage port"
  - packages/adapter-d1/README.md "Transactions"
  - packages/adapter-postgres/README.md "Transactions"
  - docs/superpowers/plans/2026-10-14-12f-operator-tools.md "Task 7"
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

## The optional methods

An adapter can leave these out. Core then takes a fixed worst case.

| Method | What it does |
| --- | --- |
| `statementsSent` | Answers the count of statements that the adapter sent since its creation, its transactions included. D1 counts each statement of a batch and the queries of its ready check, also in the D1 storage of the Better Auth tables. Memory and Postgres count their port calls. The operator session calls and the sweep read it, so each call fits the 50 queries of D1 Free. |
| `readyStatements` | Runs the ready check of the adapter when it has not run, such as the schema version check, and answers the count of statements that the check sent. The operator session calls reserve it in their budget. A core D1 adapter answers 1. The D1 storage of the Better Auth tables answers 4: it also reads the indexes of the account table. Without it core reserves 1. |
| `lockInOrder` | Inside a transaction, takes the row locks of the rows that match, by id, in one statement. Postgres runs `SELECT ... ORDER BY id FOR UPDATE`. D1 and memory have no row lock and leave it out. Each flow that deletes many sessions calls it first, the sweep too, so two such flows wait in turn and never on each other. An adapter on a database with row locks must have it: without it two such flows can deadlock. |

## The rules

- Clauses join with AND only. There is no OR and no join. When core needs two tables, it does two reads.
- The operators are `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, and `startsWith`.
- `startsWith` matches a string field whose value begins with the exact text of the prefix. Case counts, as it does for `eq`. A `%` or a `_` is plain text. It never matches null.
- The prefix goes to the database as a parameter, never as SQL text. An SQL adapter compares `substr(column, 1, n)`, where n is the count of code points. No index serves that clause, so each call reads the whole table.
- `startsWith` throws `invalid_argument` for an empty prefix, a value that is not a string, or a field that is not a string. It also refuses a prefix with a lone surrogate or with NUL.
- `update` and `delete` take a `where`, never a bare id. So core can say "spend this token only if it is not spent" in one statement.
- An empty `in` list matches nothing. An empty `where` on `update` or `delete` is an error.
- Two null values never conflict on a unique key.
- Reads inside a transaction see the transaction's own writes.
- A sort takes one key or a list of keys, each with its own direction.
- The field types are string, boolean, integer, date, and json.

## Why so narrow

A narrow port is easy to keep on every database. D1 has no interactive transaction, and SQLite and Postgres differ in their types. Each method has a small, fixed meaning, so an adapter has little room to differ from another.

The guards of core live in the `where` clauses and the unique keys, not in the isolation of a transaction. So the same guard works on D1 and on Postgres. [The race rules](/docs/concepts/races/) tell how.

## The contract

`runAdapterConformance` from `@authtempo/core/conformance` is the contract. It runs the same tests on every adapter: the operators, the sorts, the unique keys, the transactions, and the round trip of every model. It also checks the optional methods: the count of each port call in `statementsSent`, and the row locks of `lockInOrder`. Pass `rowLocks: true` for a database with row locks: the suite then fails when `lockInOrder` is missing. Pass `updateInTransaction` when an update in a transaction sends more than one statement, as on D1 (2). An adapter that fails it does not ship.

## The schema version

The schema is one typed object in core, and its version is a constant. Each adapter ships one migration per version. An adapter refuses to run on a database with an older version. [Schema and migrations](/docs/reference/schema/) lists the versions.

## Next

- [Write a storage adapter](/docs/guides/adapter/)
- [The race rules](/docs/concepts/races/)
- [Schema and migrations](/docs/reference/schema/)
