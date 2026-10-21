import { type ModelName, schema } from "@authtempo/core";
import { auxColumnType, columnType, MYSQL_STRINGS } from "@authtempo/core/ddl";
import {
  AUX_TABLES,
  columnName,
  type ExpectedShape,
  type ExpectedTable,
  indexName,
  type LiveShape,
  type LiveTable,
  MYSQL,
  type ShapeIndex,
  TABLES,
  uniqueIndexName,
} from "@authtempo/core/sql";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { MYSQL_TABLE_COLLATION } from "./start-checks.js";

/** One sort order for the tables and the indexes of both shapes, so a parity test compares them as arrays. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The shape type of a DDL column type (deviation 3 of plan 12g). It is the
 * `COLUMN_TYPE` of `information_schema.columns` in lower case. Its
 * `COLLATION_NAME` follows when it has one. A TEXT column has the table's collation.
 */
export function mysqlShapeType(ddl: string): string {
  const string = /^(.*) CHARACTER SET \w+ COLLATE (\w+)$/.exec(ddl);
  if (string) return `${string[1]?.toLowerCase()} ${string[2]}`;
  if (ddl === "TEXT") return `text ${MYSQL_TABLE_COLLATION}`;
  return ddl.toLowerCase();
}

/** The index column of `field`: `<column>(<n>)` when the index takes a prefix. */
function indexColumn(model: ModelName, field: string): string {
  const prefix = MYSQL_STRINGS[`${model}.${field}`]?.prefix;
  return prefix === undefined ? columnName(field) : `${columnName(field)}(${prefix})`;
}

function modelTable(model: ModelName): ExpectedTable {
  const fields = schema[model].fields as Record<string, { nullable?: boolean }>;
  return {
    name: TABLES[model],
    columns: Object.entries(fields).map(([field, def]) => ({
      name: columnName(field),
      type: mysqlShapeType(columnType(MYSQL, model, field)),
      notNull: def.nullable !== true,
    })),
    primaryKey: ["id"],
    unique: schema[model].unique
      .map((f) => ({ name: uniqueIndexName(model, f), columns: f.map(columnName) }))
      .sort(byName),
    indexes: schema[model].indexes
      .map((f) => ({ name: indexName(model, f), columns: f.map((x) => indexColumn(model, x)) }))
      .sort(byName),
  };
}

/** `AUX_TABLES` from core's column map, and the runner's own table of `src/migrations.ts`. */
const OTHER_TABLES: readonly ExpectedTable[] = [
  ...AUX_TABLES.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: mysqlShapeType(auxColumnType(MYSQL, t.name, c.name)),
      notNull: true,
    })),
    primaryKey: t.primaryKey,
    unique: [],
    indexes: t.indexes,
  })),
  {
    name: "ta_migrations",
    columns: [
      { name: "name", type: "varchar(128) ascii_bin", notNull: true },
      { name: "step", type: "int", notNull: true },
      { name: "applied_at", type: "bigint", notNull: true },
    ],
    primaryKey: ["name", "step"],
    unique: [],
    indexes: [],
  },
];

/** The tables that the MySQL migrations make, sorted by name (plan 11c2 types). */
export function expectedMysqlShape(): ExpectedShape {
  const models = Object.keys(schema) as ModelName[];
  return [...models.map(modelTable), ...OTHER_TABLES].sort(byName);
}

// `ta\_%` escapes the underscore, so the pattern matches the prefix `ta_` only.
// The columns of a view are also in information_schema.columns, so the read
// keeps base tables only.
const COLUMNS_SQL = `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
  c.COLLATION_NAME AS collation_name, c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.EXTRA AS extra
FROM information_schema.columns c
JOIN information_schema.tables t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME LIKE 'ta\\_%' AND t.TABLE_TYPE = 'BASE TABLE'
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

const INDEXES_SQL = `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique,
  COLUMN_NAME AS column_name, SUB_PART AS sub_part, EXPRESSION AS expression
FROM information_schema.statistics
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ta\\_%'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

/**
 * The live shape of each `ta_` table of the pool's database (plan 11c2). It
 * runs two SELECT statements and writes nothing. The index PRIMARY gives the
 * primary key. An index column with a prefix reads `<column>(<n>)`, and an
 * expression reads as its text.
 */
export async function readMysqlShape(pool: Pool): Promise<LiveShape> {
  const [columns] = await pool.query<RowDataPacket[]>(COLUMNS_SQL);
  const [indexes] = await pool.query<RowDataPacket[]>(INDEXES_SQL);
  const tables = new Map<
    string,
    {
      columns: LiveTable["columns"][number][];
      primaryKey: string[];
      unique: Map<string, string[]>;
      indexes: Map<string, string[]>;
    }
  >();
  for (const c of columns) {
    let t = tables.get(c.table_name);
    if (!t) {
      t = { columns: [], primaryKey: [], unique: new Map(), indexes: new Map() };
      tables.set(c.table_name, t);
    }
    const extra = String(c.extra ?? "");
    t.columns.push({
      name: c.column_name,
      type: c.collation_name === null ? c.column_type : `${c.column_type} ${c.collation_name}`,
      notNull: c.is_nullable === "NO",
      // MySQL makes the value of an auto_increment or a generated column.
      hasDefault:
        c.column_default !== null || /auto_increment/i.test(extra) || /\bGENERATED\b/i.test(extra),
    });
  }
  for (const ix of indexes) {
    const t = tables.get(ix.table_name);
    if (!t) continue;
    const column =
      ix.column_name === null
        ? String(ix.expression)
        : ix.sub_part === null
          ? ix.column_name
          : `${ix.column_name}(${ix.sub_part})`;
    if (ix.index_name === "PRIMARY") {
      t.primaryKey.push(column);
      continue;
    }
    const kind = Number(ix.non_unique) === 0 ? t.unique : t.indexes;
    const list = kind.get(ix.index_name) ?? [];
    list.push(column);
    kind.set(ix.index_name, list);
  }
  const listOf = (m: Map<string, string[]>): ShapeIndex[] =>
    [...m].map(([name, columns]) => ({ name, columns })).sort(byName);
  return [...tables]
    .map(
      ([name, t]): LiveTable => ({
        name,
        columns: t.columns,
        primaryKey: t.primaryKey,
        unique: listOf(t.unique),
        indexes: listOf(t.indexes),
      }),
    )
    .sort(byName);
}
