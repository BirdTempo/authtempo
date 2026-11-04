---
"@authtempo/core": minor
"@authtempo/adapter-d1": minor
"@authtempo/adapter-postgres": minor
"@authtempo/adapter-mysql": minor
"@authtempo/adapter-sqlite": minor
"@authtempo/compat-better-auth": minor
---

Breaking: a storage adapter must have two new port calls, `deleteRows` and `keep`. An adapter of your own fails the type check until it adds them.

`deleteRows(model, where)` deletes the rows that match and answers them. A row that another caller removed first is not in the answer. D1, SQLite, and Postgres run one `DELETE … RETURNING`. MySQL reads the ids, reads the rows under their locks by id, and deletes them by id, in one transaction.

`keep()` makes the writes of the open transaction so far final, so a later throw undoes only the later writes. D1, SQLite, and the memory store drop their undo entries so far and answer true. Postgres and MySQL isolate the open transaction, so there it does nothing and answers false. The conformance suite holds both calls on every store, with the option `deleteRowsStatements` for MySQL. The storage of the Better Auth tables answers each row of `deleteRows` in the shape that a read gives.
