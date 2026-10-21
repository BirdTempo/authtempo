import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SqliteDriver } from "./adapter.js";
import { syncDriver } from "./sync.js";

/**
 * A SqliteDriver over a `bun:sqlite` database that the app opened. `?1` and
 * `?2` bind by position on this driver. Open it without `safeIntegers`: the
 * adapter refuses it.
 */
export function bunSqlite(db: Database): SqliteDriver {
  return syncDriver({
    name: "bun:sqlite",
    all: (sql, values) =>
      db.query(sql).all(...(values as SQLQueryBindings[])) as Record<string, unknown>[],
    exec: (script) => {
      db.run(script);
    },
  });
}
