import { D1_SHAPE_SQL, expectedD1Shape, parseD1Shape } from "@authtempo/adapter-d1";
import type { ExpectedShape, LiveShape } from "@authtempo/core/sql";
import type { SqliteDriver } from "./adapter.js";

/**
 * The tables that the SQLite migrations make: the D1 tables, plus the list
 * of applied migrations that `applySqliteMigrations` keeps. Wrangler keeps
 * that list on D1, so the D1 shape does not hold it.
 */
export function expectedSqliteShape(): ExpectedShape {
  return [
    ...expectedD1Shape(),
    {
      // src/migrations.ts, the table of applySqliteMigrations.
      name: "ta_migrations",
      columns: [
        { name: "name", type: "TEXT", notNull: true },
        { name: "applied_at", type: "INTEGER", notNull: true },
      ],
      primaryKey: ["name"],
      unique: [],
      indexes: [],
    },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Reads the live shape with the two reads of the D1 package (one source). */
export async function readSqliteShape(driver: SqliteDriver): Promise<LiveShape> {
  const columns = await driver.db.prepare(D1_SHAPE_SQL.columns).all();
  const indexes = await driver.db.prepare(D1_SHAPE_SQL.indexes).all();
  return parseD1Shape(columns.results, indexes.results);
}
