import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqliteDriver } from "./adapter.js";
import { syncDriver } from "./sync.js";

/**
 * A SqliteDriver over a `node:sqlite` database that the app opened (Node
 * 22.13 or newer). `?NNN` binds by position on this driver (read 2026-10-21,
 * SQLite 3.54.0). Open it without `readBigInts`: the adapter refuses it.
 */
export function nodeSqlite(db: DatabaseSync): SqliteDriver {
  return syncDriver({
    name: "node:sqlite",
    all: (sql, values) => db.prepare(sql).all(...(values as SQLInputValue[])),
    exec: (script) => db.exec(script),
  });
}
