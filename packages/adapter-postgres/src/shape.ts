import { type ModelName, schema } from "@authtempo/core";
import { auxColumnType } from "@authtempo/core/ddl";
import {
  AUX_TABLES,
  columnName,
  type ExpectedShape,
  type ExpectedTable,
  indexName,
  type LiveShape,
  type LiveTable,
  POSTGRES,
  type ShapeIndex,
  TABLES,
  uniqueIndexName,
} from "@authtempo/core/sql";
import type { Sql } from "postgres";
import { type CoreFieldType, postgresColumnType } from "./column-types.js";

/** One sort order for the tables and the indexes of both shapes, so a parity test compares them as arrays. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function modelTable(model: ModelName): ExpectedTable {
  const fields = schema[model].fields as Record<
    string,
    { type: CoreFieldType; nullable?: boolean }
  >;
  return {
    name: TABLES[model],
    columns: Object.entries(fields).map(([field, def]) => ({
      name: columnName(field),
      type: postgresColumnType(field, def.type),
      notNull: !def.nullable,
    })),
    primaryKey: ["id"],
    unique: schema[model].unique
      .map((f) => ({ name: uniqueIndexName(model, f), columns: f.map(columnName) }))
      .sort(byName),
    indexes: schema[model].indexes
      .map((f) => ({ name: indexName(model, f), columns: f.map(columnName) }))
      .sort(byName),
  };
}

/**
 * The three tables that the Postgres migrations make beside `schema`. A
 * primary key column is NOT NULL in Postgres, so `notNull` is true for it.
 * `ta_meta` and `ta_limit` (`src/migrations/0001_schema_v1.ts` and
 * `0003_schema_v3.ts`) come from core's `AUX_TABLES` and its column map
 * (ruling 12 of plan 12g). `ta_migrations` is the runner's own table.
 */
const OTHER_TABLES: readonly ExpectedTable[] = [
  ...AUX_TABLES.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: auxColumnType(POSTGRES, t.name, c.name),
      notNull: true,
    })),
    primaryKey: t.primaryKey,
    unique: [],
    indexes: t.indexes,
  })),
  // MIGRATIONS_TABLE_SQL of src/migrations.ts, the list of applied migrations that applyPostgresMigrations keeps.
  {
    name: "ta_migrations",
    columns: [
      { name: "name", type: "text", notNull: true },
      { name: "applied_at", type: "timestamp with time zone", notNull: true },
    ],
    primaryKey: ["name"],
    unique: [],
    indexes: [],
  },
];

/**
 * The tables that the Postgres migrations make, sorted by name (plan 11c2).
 * Each type is the `data_type` of `information_schema.columns`. The parity
 * test of this package compares it with a fresh database.
 *
 * The compat migrations of `@authtempo/compat-better-auth` make `ta_meta`,
 * `ta_limit`, and seven core model tables. A compat database does not have
 * this shape, so the `schema_shape` check is for a core database only.
 */
export function expectedPostgresShape(): ExpectedShape {
  const models = Object.keys(schema) as ModelName[];
  return [...models.map(modelTable), ...OTHER_TABLES].sort(byName);
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  is_generated: string;
}

interface IndexRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

// `ta\_%` escapes the underscore, so the pattern matches the prefix `ta_` only.
// The columns of a view are also in `information_schema.columns`, so the read
// keeps base tables only. D1 does the same with `type = 'table'`.
const COLUMNS_SQL = `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, is_generated
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name LIKE 'ta\\_%'
AND table_name IN (SELECT table_name FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_type = 'BASE TABLE')
ORDER BY table_name, ordinal_position`;

const INDEXES_SQL = `SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema() AND tablename LIKE 'ta\\_%'
ORDER BY tablename, indexname`;

/**
 * The key list of an `indexdef`: the text in the parentheses after
 * `USING <method>`. A comma inside a nested parenthesis (an expression)
 * does not split. A quoted name loses its quotes.
 */
function indexColumns(def: string): string[] {
  const start = /\sUSING\s+\w+\s*\(/.exec(def);
  if (!start) return [def];
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of def.slice(start.index + start[0].length)) {
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(part);
      part = "";
      continue;
    }
    part += ch;
  }
  parts.push(part);
  return parts.map((p) => p.trim().replace(/^"(.*)"$/, "$1"));
}

/**
 * The live shape of each `ta_` table in the connection's current schema
 * (plan 11c2). It runs two SELECT statements and writes nothing. The index
 * `<table>_pkey` gives the primary key.
 */
export async function readPostgresShape(sql: Sql): Promise<LiveShape> {
  const columns = await sql.unsafe<ColumnRow[]>(COLUMNS_SQL);
  const indexes = await sql.unsafe<IndexRow[]>(INDEXES_SQL);
  const tables = new Map<
    string,
    {
      columns: LiveTable["columns"][number][];
      primaryKey: string[];
      unique: ShapeIndex[];
      indexes: ShapeIndex[];
    }
  >();
  for (const c of columns) {
    let t = tables.get(c.table_name);
    if (!t) {
      t = { columns: [], primaryKey: [], unique: [], indexes: [] };
      tables.set(c.table_name, t);
    }
    t.columns.push({
      name: c.column_name,
      type: c.data_type,
      notNull: c.is_nullable === "NO",
      // An identity or a generated column has no column_default, but Postgres
      // makes its value, so an insert that leaves it out does not fail.
      hasDefault:
        c.column_default !== null || c.is_identity === "YES" || c.is_generated === "ALWAYS",
    });
  }
  for (const ix of indexes) {
    const t = tables.get(ix.tablename);
    if (!t) continue;
    const cols = indexColumns(ix.indexdef);
    if (ix.indexname === `${ix.tablename}_pkey`) t.primaryKey = cols;
    else if (/^CREATE UNIQUE INDEX\s/.test(ix.indexdef))
      t.unique.push({ name: ix.indexname, columns: cols });
    else t.indexes.push({ name: ix.indexname, columns: cols });
  }
  return [...tables]
    .map(
      ([name, t]): LiveTable => ({
        name,
        columns: t.columns,
        primaryKey: t.primaryKey,
        unique: t.unique.sort(byName),
        indexes: t.indexes.sort(byName),
      }),
    )
    .sort(byName);
}
