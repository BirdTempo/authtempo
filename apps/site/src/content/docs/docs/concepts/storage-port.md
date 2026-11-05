---
title: The storage port
description: The ten storage methods that core calls, the rules that every adapter keeps, and why the port is so narrow.
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
| `createMany` | Writes rows of one model and answers them, all or nothing. It sends one INSERT per chunk of `rowsPerInsert` rows, and nothing for an empty list. On D1 and SQLite a statement of more than 100 KB splits in halves. A unique clash fails the call, and no row of the call stays. |
| `rowsPerInsert` | Answers the most rows of a model that one INSERT of `createMany` writes. That is the bound parameters of the database over the columns of a row, and at most 1000. Postgres and MySQL bind one parameter per value: postgres.js takes 65533, MySQL 65535. D1 and SQLite bind the rows as one JSON list, so they answer 1000. |
| `findOne` | Answers the first row that matches, or null. |
| `findMany` | Answers the rows that match, with an optional sort and limit. |
| `update` | Writes the fields to every row that matches, and answers the count. |
| `delete` | Deletes every row that matches, and answers the count. |
| `deleteRows` | Deletes every row that matches, and answers the rows that it removed. A row that another caller removed first is not in the answer. D1, SQLite, and Postgres run one `DELETE … RETURNING`. MySQL reads the ids, reads the rows under their locks by id, and deletes them by id, in one transaction. |
| `keep` | Inside a transaction, makes the writes so far final: a later throw undoes only the writes after it. D1, SQLite, and memory drop their undo entries so far, and answer true. Postgres and MySQL do nothing and answer false: they isolate the open transaction, so a throw still undoes all of it. |
| `transaction` | Runs a function with a port whose writes commit together. |

## The flag

An adapter sets this flag on the port and on each transaction port.

| Flag | What it means |
| --- | --- |
| `isolated` | True when the open transaction is isolated, so `keep` answers false in it. Postgres and MySQL set it true. D1, SQLite, and memory set it false: they keep an undo log, and each write lands at once. A claim reads it to choose its first statement. On an isolated store that is the hold, an update of the user row that takes its lock. Else it is the lease, a `claim-lease` verification row of the user that lives 60 seconds. The suite holds the flag to `keep`. |

## The optional methods

An adapter can leave these out. Core then takes a fixed worst case.

| Method | What it does |
| --- | --- |
| `statementsSent` | Answers the count of statements that the adapter sent since its creation, its transactions included. D1 counts each statement of a batch and the queries of its ready check, also in the D1 storage of the Better Auth tables. Memory and Postgres count their port calls. The operator session calls and the sweep read it, so each call fits the 50 queries of D1 Free. |
| `queryLimitPerInvocation` | True when the database caps the queries of one invocation. D1 sets it: D1 Free allows 50 queries per invocation. Only then do the self delete and the operator delete answer `delete_too_large` when their least work cannot fit. The flag also keeps the page of the own sessions of an account delete inside 50. Postgres, MySQL, SQLite, and memory leave it out. Their deletes refuse only past 50 solo organizations, and the page ends up to 500 of the user's own sessions in one act. |
| `readyStatements` | Runs the ready check of the adapter when it has not run, such as the schema version check. It answers the count of statements that the check sent. The operator session calls reserve it in their budget. A core D1 adapter answers 1. The D1 storage of the Better Auth tables answers 4: it also reads the indexes of the account table. Without it core reserves 1. |
| `userDeleteCascades` | True when a user delete cascades by foreign keys. It then also deletes the sessions, the accounts, the member rows, and the invitations that the user sent. The storage of the Better Auth tables sets it on every dialect. There the account delete runs every check that can refuse, and the pages of the sessions, before the user delete. So a refusal changes nothing, and `session.afterEnd` sees each session of the page. Core's own tables have no foreign key and leave it out (ruling 13 of plan 12f2). |
| `lockInOrder` | Inside a transaction, takes the row locks of the rows that match, by id, in one statement. Postgres runs `SELECT ... ORDER BY id FOR UPDATE`. D1 and memory have no row lock and leave it out. Each flow that deletes many sessions calls it first, the sweep too, so two such flows wait in turn and never on each other. An adapter on a database with row locks must have it: without it two such flows can deadlock. |
| `ping` | Reads the stored schema version with no cache at each call, and throws `schema_mismatch` for an old one. `GET /ready` calls it. Its statements count in `statementsSent`. Without it core reads a user row by an id that no row holds. |
| `undoOnlyWhile` | Inside a transaction, the undo of each later delete puts its rows back only while a row of the model matches the where. The check is a term of the undo statement, so the call sends no query. A second call at a level replaces the condition, also for the deletes since the first call. `keep` and the end of the level end it. D1, SQLite, and memory have it on each transaction. A claim calls it after its lease, with the unverified user as the condition. Postgres and MySQL leave it out: a throw undoes the whole transaction there. |

## The rules

- Clauses join with AND only. There is no OR and no join. When core needs two tables, it does two reads.
- The operators are `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, and `startsWith`.
- `startsWith` matches a string field whose value begins with the exact text of the prefix. Case counts, as it does for `eq`. A `%` or a `_` is plain text. It never matches null.
- The prefix goes to the database as a parameter, never as SQL text. An SQL adapter compares `substr(column, 1, n)`, where n is the count of code points. No index serves that clause, so each call reads the whole table.
- `startsWith` throws `invalid_argument` for an empty prefix, a value that is not a string, or a field that is not a string. It also refuses a prefix with a lone surrogate or with NUL.
- A string with NUL or with a lone surrogate in any `where` value throws `invalid_argument`, also in an `in` list. The rule holds on every op and every store.
- `update` and `delete` take a `where`, never a bare id. So core can say "spend this token only if it is not spent" in one statement.
- An empty `in` list matches nothing. An empty `where` on `update` or `delete` is an error.
- An `in` list of up to 1000 values is one statement on every store. On D1 and SQLite a list of more than 50 values binds as one JSON text, which `json_each` reads. No value enters the SQL text.
- Two null values never conflict on a unique key.
- Reads inside a transaction see the transaction's own writes.
- A throw inside a transaction undoes the transaction's own writes. After `keep`, it undoes only the writes after that call. A claim calls `keep` after its last write, so a later failure keeps the claim.
- A sort takes one key or a list of keys, each with its own direction. A key with `notNull: true` must name a field that is not nullable. The SQL then has no null term, so an index can give the order.
- The field types are string, boolean, integer, date, and json.

## Why so narrow

A narrow port is easy to keep on every database. D1 has no interactive transaction, and SQLite and Postgres differ in their types. Each method has a small, fixed meaning, so an adapter has little room to differ from another.

The guards of core live in the `where` clauses and the unique keys, not in the isolation of a transaction. So the same guard works on D1 and on Postgres. [The race rules](/docs/concepts/races/) tell how.

## The contract

`runAdapterConformance` from `@authtempo/core/conformance` is the contract. It runs the same tests on every adapter: the operators, the sorts, the unique keys, the transactions, and the round trip of every model. It also checks the optional methods: the count of each port call in `statementsSent`, and the row locks of `lockInOrder` and their order by id. A lock in scan order fails the suite: it can deadlock with a flow that locks by id. Pass `rowLocks: true` for a database with row locks: the suite then fails when `lockInOrder` is missing. Pass `updateInTransaction` when an update in a transaction sends more than one statement, as on D1 (2). The suite holds `deleteRows` to a rival delete that runs first, and `keep` to a later throw. Pass `deleteRowsStatements` when one `deleteRows` sends more than one statement, as on MySQL (3). The suite holds `undoOnlyWhile` on each store that has it. Pass `undoGuard: true` for an adapter that must have it, as each store with an undo log does. An adapter that fails it does not ship.

## The schema version

The schema is one typed object in core, and its version is a constant. Each adapter ships one migration per version. An adapter refuses to run on a database with an older version. [Schema and migrations](/docs/reference/schema/) lists the versions.

## Next

- [Write a storage adapter](/docs/guides/adapter/)
- [The race rules](/docs/concepts/races/)
- [Schema and migrations](/docs/reference/schema/)
