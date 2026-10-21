import type Database from "better-sqlite3";
import type { SqliteDriver } from "./adapter.js";
import { syncDriver } from "./sync.js";

/** `?1`, `?2`, ... in the text: the D1 limiter's statements use them. */
const NUMBERED = /\?\d/;

/**
 * A SqliteDriver over a better-sqlite3 database that the app opened. Open it
 * without `defaultSafeIntegers(true)`: the adapter refuses it.
 */
export function betterSqlite3(db: Database.Database): SqliteDriver {
  return syncDriver({
    name: "better-sqlite3",
    all: (sql, values) => {
      const st = db.prepare(sql);
      // better-sqlite3 13.0.3 refuses positional values for `?NNN` ("Too many
      // parameter values were provided") and takes an object keyed 1..n (read
      // 2026-10-21). The D1 SQL text stays the same (ruling 1 of plan 12g, N3).
      const args = NUMBERED.test(sql)
        ? [Object.fromEntries(values.map((v, i) => [i + 1, v]))]
        : [...values];
      // all() refuses a statement that returns no rows; run() runs it.
      if (!st.reader) {
        st.run(...args);
        return [];
      }
      return st.all(...args) as Record<string, unknown>[];
    },
    exec: (script) => {
      db.exec(script);
    },
  });
}
