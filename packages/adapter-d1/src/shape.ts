import { type ModelName, schema } from "@authtempo/core";
import {
  columnName,
  type ExpectedShape,
  type ExpectedTable,
  type encodeValue,
  indexName,
  type LiveShape,
  type LiveTable,
  META_TABLE,
  type ShapeIndex,
  TABLES,
  uniqueIndexName,
} from "@authtempo/core/sql";

/** A core field type, as `schema` names it. */
type CoreFieldType = Parameters<typeof encodeValue>[1];

/**
 * The D1 column type of each core field. The rule comes from the comment at
 * the top of `migrations/0001_schema_v1.sql`. A date is INTEGER epoch
 * milliseconds, a boolean is INTEGER 0 or 1, and JSON is TEXT.
 */
export function d1ColumnType(type: CoreFieldType): "TEXT" | "INTEGER" {
  switch (type) {
    case "string":
    case "json":
      return "TEXT";
    case "boolean":
    case "integer":
    case "date":
      return "INTEGER";
  }
}

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
      type: d1ColumnType(def.type),
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
 * The two tables that the D1 migrations make beside `schema`. Wrangler keeps
 * its own list of applied migrations in `d1_migrations`, which has no `ta_`
 * prefix, so the shape does not hold it.
 */
const OTHER_TABLES: readonly ExpectedTable[] = [
  // migrations/0001_schema_v1.sql:7-10
  {
    name: META_TABLE,
    columns: [
      { name: "key", type: "TEXT", notNull: true },
      { name: "value", type: "TEXT", notNull: true },
    ],
    primaryKey: ["key"],
    unique: [],
    indexes: [],
  },
  // migrations/0003_schema_v3.sql:8-14
  {
    name: "ta_limit",
    columns: [
      { name: "key", type: "TEXT", notNull: true },
      { name: "window_start", type: "INTEGER", notNull: true },
      { name: "count", type: "INTEGER", notNull: true },
      { name: "expires_at", type: "INTEGER", notNull: true },
    ],
    primaryKey: ["key"],
    unique: [],
    indexes: [{ name: "ix_ta_limit__expires_at", columns: ["expires_at"] }],
  },
];

/**
 * The tables that the D1 migrations of this package make, sorted by name
 * (plan 11c2). The parity test of this package compares it with a fresh
 * database.
 *
 * The compat migrations of `@authtempo/compat-better-auth` make `ta_meta`,
 * `ta_limit`, and seven core model tables. A refused date check of those
 * migrations leaves `ta_date_check`. A compat database does not have this
 * shape, so the `schema_shape` check is for a core database only.
 */
export function expectedD1Shape(): ExpectedShape {
  const models = Object.keys(schema) as ModelName[];
  return [...models.map(modelTable), ...OTHER_TABLES].sort(byName);
}

/**
 * The two reads of a live D1 shape (plan 11c2). Each is one SELECT over
 * `sqlite_master` and the table-valued pragmas, so one `prepare` or one
 * `wrangler d1 execute` runs it. `ta\_%` with the escape matches the prefix
 * `ta_` only. Column order: `cid` and `seqno`. The alias `"notNull"` has
 * quotes, because NOTNULL is an SQLite keyword: without them the read fails
 * with a syntax error.
 */
export const D1_SHAPE_SQL: { columns: string; indexes: string } = {
  columns: `SELECT m.name AS tableName, p.name AS name, p.type AS type, p."notnull" AS "notNull", p.dflt_value AS dflt, p.pk AS pk FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY m.name, p.cid`,
  indexes: `SELECT m.name AS tableName, il.name AS name, il."unique" AS isUnique, il.origin AS origin, ii.seqno AS seqno, ii.name AS col FROM sqlite_master m, pragma_index_list(m.name) il, pragma_index_info(il.name) ii WHERE m.type = 'table' AND m.name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY m.name, il.name, ii.seqno`,
};

/** Returns an Error that names the field of a shape row whose value has the wrong type. */
function wrongType(name: string, kind: string): Error {
  return new Error(`d1 shape row: the field ${name} is not ${kind}`);
}

function text(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw wrongType(name, "a string");
  return value;
}

function textOrNull(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") throw wrongType(name, "a string or null");
  return value;
}

function count(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number") throw wrongType(name, "a number");
  return value;
}

interface IndexColumn {
  seqno: number;
  col: string;
}

function record(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null)
    throw new Error("d1 shape row: the row is not an object");
  return row as Record<string, unknown>;
}

/**
 * Builds the live shape from the rows of the two `D1_SHAPE_SQL` reads (plan
 * 11c2). The rows come from a database, so each field is checked first. The
 * primary key comes from the columns with `pk` above 0, in `pk` order. Only an
 * index of origin `c` (a CREATE INDEX) counts: SQLite makes its own index for a
 * primary key or an inline UNIQUE.
 */
export function parseD1Shape(columns: unknown[], indexes: unknown[]): LiveShape {
  const tables = new Map<
    string,
    {
      columns: LiveTable["columns"][number][];
      pk: { name: string; pk: number }[];
      unique: Map<string, IndexColumn[]>;
      indexes: Map<string, IndexColumn[]>;
    }
  >();
  for (const raw of columns) {
    const row = record(raw);
    const tableName = text(row, "tableName");
    const name = text(row, "name");
    const type = text(row, "type");
    const notNull = count(row, "notNull");
    const dflt = textOrNull(row, "dflt");
    const pk = count(row, "pk");
    let t = tables.get(tableName);
    if (!t) {
      t = { columns: [], pk: [], unique: new Map(), indexes: new Map() };
      tables.set(tableName, t);
    }
    t.columns.push({ name, type, notNull: notNull !== 0, hasDefault: dflt !== null });
    if (pk > 0) t.pk.push({ name, pk });
  }
  for (const raw of indexes) {
    const row = record(raw);
    const tableName = text(row, "tableName");
    const name = text(row, "name");
    const isUnique = count(row, "isUnique");
    const origin = text(row, "origin");
    const seqno = count(row, "seqno");
    // An index on an expression has no column name.
    const col = textOrNull(row, "col") ?? "(an expression)";
    const t = tables.get(tableName);
    if (!t || origin !== "c") continue;
    const list = isUnique !== 0 ? t.unique : t.indexes;
    list.set(name, [...(list.get(name) ?? []), { seqno, col }]);
  }
  const indexList = (m: Map<string, IndexColumn[]>): ShapeIndex[] =>
    [...m]
      .map(([name, cols]) => ({
        name,
        columns: [...cols].sort((a, b) => a.seqno - b.seqno).map((c) => c.col),
      }))
      .sort(byName);
  return [...tables]
    .map(
      ([name, t]): LiveTable => ({
        name,
        columns: t.columns,
        primaryKey: [...t.pk].sort((a, b) => a.pk - b.pk).map((c) => c.name),
        unique: indexList(t.unique),
        indexes: indexList(t.indexes),
      }),
    )
    .sort(byName);
}
