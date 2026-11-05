---
"@authtempo/adapter-d1": minor
"@authtempo/adapter-sqlite": patch
"@authtempo/compat-better-auth": patch
---

The D1 adapter has `undoOnlyWhile` on each transaction. The undo of a delete under it is one `INSERT ... SELECT ... WHERE EXISTS` statement, so the check adds no query. It also has `deleteOnlyWhile`, one `DELETE ... AND EXISTS (...) RETURNING` statement, so that check adds no query either. The SQLite adapter runs the same code, so it has the call too. The D1 and SQLite storages of the Better Auth tables also run that code. Their statements build the same guarded insert and the same guarded delete.
