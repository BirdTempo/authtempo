import {
  type FieldDef,
  type FieldType,
  type ModelName,
  type Models,
  SCHEMA_VERSION,
  schema,
} from "../schema.js";
import { type FindManyOptions, type Sort, StorageError, type Where } from "./port.js";

// The bounds that the importer shares with core (plan 12g fix wave).
export { CREDENTIAL_ID_MAX_BYTES, SUBJECT_MAX } from "../bounds.js";

/**
 * The facts of one SQL dialect. A statement reads these properties, never
 * the name (plan 12g), so a new dialect cannot get the text of another one.
 */
export interface Dialect {
  name: "sqlite" | "postgres" | "mysql";
  /** 1-based parameter placeholder. */
  placeholder(i: number): string;
  /** "explicit" adds an IS NULL term so nulls sort last ascending and first descending. "native" already does. */
  nullsOrder: "explicit" | "native";
  json: "text" | "jsonb" | "json";
  /** Writes a table or column name. SQLite and Postgres write the name as it is. */
  quote(ident: string): string;
  /** "inline" writes the checked limit into the text; "parameter" sends it as a parameter. */
  limit: "parameter" | "inline";
  /** "epoch-ms" stores a date as an integer of milliseconds. */
  dates: "epoch-ms" | "native";
  /** "integer" stores a boolean as 0 or 1. */
  booleans: "integer" | "native";
  /** The equal operator that also matches a null with a null. */
  nullSafeEq: "IS" | "IS NOT DISTINCT FROM" | "<=>";
  /**
   * "json": an `in` list of more than `IN_PARAMS_MAX` values and a
   * `createMany` insert bind one JSON list, and `json_each` expands it in
   * the statement (ruling 84 of plan 12d). D1 binds 100 parameters per
   * query, so a list of one parameter per value cannot grow there.
   * "params": one parameter per value.
   */
  lists: "json" | "params";
  /**
   * "fixed": a "params" list of more than `IN_PARAMS_MAX` values pads to one of
   * `LIST_SIZES` (ruling 85 of plan 12d). A `createMany` chunk takes one of
   * those sizes too. MySQL keeps one server prepared statement per SQL text.
   * "any": a list and a chunk take any size.
   */
  listSizes: "fixed" | "any";
}

export const SQLITE: Dialect = {
  name: "sqlite",
  placeholder: () => "?",
  nullsOrder: "explicit",
  json: "text",
  quote: (s) => s,
  limit: "parameter",
  dates: "epoch-ms",
  booleans: "integer",
  nullSafeEq: "IS",
  lists: "json",
  listSizes: "any",
};

export const POSTGRES: Dialect = {
  name: "postgres",
  placeholder: (i) => `$${i}`,
  nullsOrder: "native",
  json: "jsonb",
  quote: (s) => s,
  limit: "parameter",
  dates: "native",
  booleans: "native",
  nullSafeEq: "IS NOT DISTINCT FROM",
  lists: "params",
  listSizes: "any",
};

/**
 * MySQL 8.4 and later (plan 12g). MySQL sorts nulls first ascending, so the
 * order is explicit. Each name is quoted, because `key`, `interval`, and
 * `rank` are reserved words of MySQL. MySQL refuses `IS NOT DISTINCT FROM`.
 */
export const MYSQL: Dialect = {
  name: "mysql",
  placeholder: () => "?",
  nullsOrder: "explicit",
  json: "json",
  quote: (s) => `\`${s}\``,
  limit: "inline",
  dates: "epoch-ms",
  booleans: "integer",
  nullSafeEq: "<=>",
  lists: "params",
  listSizes: "fixed",
};

export const META_TABLE = "ta_meta";
export const SCHEMA_VERSION_KEY = "schema_version";

/** One table that is not a model. `int64` is an integer of 64 bits. */
export interface AuxTable {
  name: string;
  columns: readonly { name: string; kind: "text" | "int64" }[];
  primaryKey: readonly string[];
  indexes: readonly { name: string; columns: readonly string[] }[];
}

/**
 * The tables that are not models. The limiter and the version gate own
 * their statements; the DDL and the shape check read this list (plan 12g).
 * The D1 and Postgres files of versions 1 and 3 make these columns.
 */
export const AUX_TABLES: readonly AuxTable[] = [
  {
    name: META_TABLE,
    columns: [
      { name: "key", kind: "text" },
      { name: "value", kind: "text" },
    ],
    primaryKey: ["key"],
    indexes: [],
  },
  {
    name: "ta_limit",
    columns: [
      { name: "key", kind: "text" },
      { name: "window_start", kind: "int64" },
      { name: "count", kind: "int64" },
      { name: "expires_at", kind: "int64" },
    ],
    primaryKey: ["key"],
    indexes: [{ name: "ix_ta_limit__expires_at", columns: ["expires_at"] }],
  },
];

const MODEL_NAMES = Object.keys(schema) as ModelName[];

/**
 * The one source for table names: `ta_` plus the model name in snake case,
 * the column rule. Every model before plan 8b is one lower-case word, so its
 * name does not change; `apiToken` is `ta_api_token`. Postgres folds an
 * unquoted `ta_apiToken` to lower case, so the camel form would name another
 * table than the migration.
 */
export const TABLES: Record<ModelName, string> = Object.fromEntries(
  MODEL_NAMES.map((m) => [m, `ta_${columnName(m)}`]),
) as Record<ModelName, string>;

export function columnName(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function fieldName(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function assertModel(model: string): asserts model is ModelName {
  if (!Object.hasOwn(schema, model)) throw new StorageError("unknown_model", model);
}

export function assertFields(model: ModelName, fields: Iterable<string>): void {
  const def = schema[model];
  for (const f of fields) {
    if (!Object.hasOwn(def.fields, f)) throw new StorageError("unknown_field", model, [f]);
  }
}

/**
 * The sort keys of `opts` as a list. Each field must exist, and a key with
 * `notNull` must name a field that the schema does not mark nullable: the
 * key then drops the `IS NULL` term, which would sort a null wrong.
 */
export function sortsOf<M extends ModelName>(
  model: M,
  opts: FindManyOptions<M> | undefined,
): Sort<M>[] {
  const sorts = opts?.sort === undefined ? [] : Array.isArray(opts.sort) ? opts.sort : [opts.sort];
  assertFields(
    model,
    sorts.map((x) => x.field),
  );
  for (const x of sorts)
    if (x.notNull && (schema[model].fields as Record<string, FieldDef>)[x.field]?.nullable)
      throw invalid(model, x.field, "notNull needs a field that is not nullable");
  return sorts;
}

function fieldType(model: ModelName, field: string): FieldType {
  return (schema[model].fields as Record<string, { type: FieldType }>)[field]?.type ?? "string";
}

export function columnsOf(model: ModelName): string[] {
  return Object.keys(schema[model].fields).map(columnName);
}

function fieldsOf(model: ModelName): string[] {
  return Object.keys(schema[model].fields);
}

export function uniqueIndexName(model: ModelName, fields: readonly string[]): string {
  return `ux_${TABLES[model]}__${fields.map(columnName).join("__")}`;
}

/** The name of a plain index of `fields`, the rule of the migrations: `ix_<table>__<col>__<col>`. */
export function indexName(model: ModelName, fields: readonly string[]): string {
  return `ix_${TABLES[model]}__${fields.map(columnName).join("__")}`;
}

/** One column as a migration makes it (plan 11c2). `type` is the database's own name: `bigint` on Postgres, `INTEGER` on D1. */
export interface ShapeColumn {
  name: string;
  type: string;
  notNull: boolean;
}

/** One index by its name and its columns in order. */
export interface ShapeIndex {
  name: string;
  columns: readonly string[];
}

export interface ExpectedTable {
  name: string;
  columns: readonly ShapeColumn[];
  primaryKey: readonly string[];
  unique: readonly ShapeIndex[];
  indexes: readonly ShapeIndex[];
}

/** The tables that an adapter's migrations make, sorted by name (plan 11c2). The adapters export it; the CLI reads it. */
export type ExpectedShape = readonly ExpectedTable[];

/** A live column also says whether it has a default: an extra NOT NULL column with no default fails each insert. */
export interface LiveTable extends Omit<ExpectedTable, "columns"> {
  columns: readonly (ShapeColumn & { hasDefault: boolean })[];
}

export type LiveShape = readonly LiveTable[];

/** Parses an index or constraint name back to field names, or null when it is not ours. */
export function fieldsFromUniqueIndex(model: ModelName, name: string): string[] | null {
  const table = TABLES[model];
  if (name === `${table}_pkey`) return ["id"];
  const prefix = `ux_${table}__`;
  if (!name.startsWith(prefix)) return null;
  const fields = name.slice(prefix.length).split("__").map(fieldName);
  const known = new Set(fieldsOf(model));
  return fields.every((f) => known.has(f)) ? fields : null;
}

export function fieldsFromColumns(model: ModelName, columns: string[]): string[] {
  const known = new Set(fieldsOf(model));
  return columns.map(fieldName).filter((f) => known.has(f));
}

function invalid(model: ModelName, field: string, why: string): StorageError {
  const e = new StorageError("invalid_argument", model, [field]);
  e.message = `${e.message}: ${why}`;
  return e;
}

const NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000/;

/**
 * The text rule of a where value, on every store (rulings 16 and 17 of plan
 * 12g). A NUL is refused in every string, as the codec does. A lone
 * surrogate is no code point, and the stores read it in other ways. libSQL
 * over HTTP fails the whole request with HTTP 400. So a where value with
 * either one throws invalid_argument before any store sees it. An `in`
 * list is checked item by item.
 */
export function assertWhereText(model: ModelName, field: string, value: unknown): void {
  const fault = whereTextFault(value);
  if (fault !== null) throw invalid(model, field, `a where value holds ${fault}`);
}

/**
 * The fault of a where value under the text rule of `assertWhereText`, or
 * null when the value passes. An adapter that rewrites a where value calls
 * it, so its rule and the rule of core cannot differ.
 */
export function whereTextFault(value: unknown): "a NUL character" | "a lone surrogate" | null {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== "string") continue;
    if (v.includes("\u0000")) return "a NUL character";
    if (/\p{Cs}/u.test(v)) return "a lone surrogate";
  }
  return null;
}

/**
 * `text` with each lone surrogate as U+FFFD: `String.prototype.toWellFormed`
 * of ES2024. The engines floor is Node 22 (the root package.json), and Node
 * 22, Bun, and Workers have it. The lib of this build is ES2023, so the
 * type comes here. A lone surrogate is no code point. A driver that writes
 * the text as UTF-8 stores U+FFFD. But a JSON list stores the bytes of the
 * surrogate (CESU-8), and libSQL aborts on their read. So every write form
 * stores U+FFFD (ruling 85 of plan 12d). No fallback: a branch that no
 * supported runtime takes has no test (ruling 86 of plan 12d).
 */
export function wellFormed(text: string): string {
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

function isPlainJson(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Encodes one value for the dialect, or throws invalid_argument when the type does not fit the column. */
export function encodeValue(
  d: Dialect,
  type: FieldType,
  value: unknown,
  model: ModelName = "user",
  field = "",
): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "string":
      if (typeof value !== "string") throw invalid(model, field, "expected a string");
      // Postgres text rejects U+0000 with a raw driver error, and SQLite stores it.
      // Refuse it on every dialect, so both adapters give the same invalid_argument.
      if (value.includes("\u0000")) throw invalid(model, field, "string holds a NUL character");
      return wellFormed(value);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        throw invalid(model, field, "expected an integer");
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw invalid(model, field, "expected a boolean");
      return d.booleans === "integer" ? (value ? 1 : 0) : value;
    case "date":
      if (!(value instanceof Date) || Number.isNaN(value.getTime()))
        throw invalid(model, field, "expected a valid Date");
      return d.dates === "epoch-ms" ? value.getTime() : value;
    case "json": {
      // Only plain objects and arrays. A Date, Map, or class instance does not
      // round-trip: JSON.stringify turns it into a string or an empty object.
      if (!isPlainJson(value)) throw invalid(model, field, "expected a plain object or an array");
      const text = JSON.stringify(value);
      // Postgres jsonb rejects the NUL escape, so refuse it on every dialect for the same behavior.
      // The pattern needs an odd run of backslashes, so a literal backslash before "u0000" passes.
      if (NUL_ESCAPE.test(text)) throw invalid(model, field, "json text holds a NUL character");
      return text;
    }
  }
}

function decodeValue(d: Dialect, type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "boolean":
      return typeof value === "number" ? value !== 0 : Boolean(value);
    case "date":
      // A driver can answer a 64-bit integer as a string of digits (plan 12g).
      if (typeof value === "string" && /^-?\d+$/.test(value)) return new Date(Number(value));
      return value instanceof Date ? value : new Date(value as string | number);
    case "json":
      // Text columns hold serialized JSON. A jsonb driver already parsed it, so a string is a real value.
      // A MySQL driver parses a JSON column, or answers its text. Core stores only an object or an array.
      return d.json !== "jsonb" && typeof value === "string" ? JSON.parse(value) : value;
    case "integer":
      return typeof value === "string" ? Number(value) : value;
    default:
      return value;
  }
}

export function decodeRow<M extends ModelName>(
  d: Dialect,
  model: M,
  row: Record<string, unknown>,
): Models[M] {
  const out: Record<string, unknown> = {};
  for (const field of fieldsOf(model)) {
    out[field] = decodeValue(d, fieldType(model, field), row[columnName(field)]);
  }
  return out as unknown as Models[M];
}

/**
 * The json parameter is serialized text. `::text::jsonb` makes the server type
 * the parameter as text, so the driver sends the string unchanged and the
 * server parses it. With a bare `::jsonb`, postgres.js learns the parameter is
 * jsonb and serializes the string a second time: the column then holds a JSON
 * string, not an object.
 */
function jsonbCast(placeholder: string): string {
  return `${placeholder}::text::jsonb`;
}

export interface Statement {
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  constructor(private readonly d: Dialect) {}
  add(v: unknown): string {
    this.values.push(v);
    return this.d.placeholder(this.values.length);
  }
}

interface Compiled {
  clause: string;
  impossible: boolean;
}

function compileWhere<M extends ModelName>(
  d: Dialect,
  model: M,
  where: Where<M>[],
  p: Params,
): Compiled {
  assertFields(
    model,
    where.map((w) => w.field),
  );
  const parts: string[] = [];
  // Validate every clause before we report "never matches", so a bad later clause still throws.
  let impossible = false;
  for (const w of where) {
    const col = d.quote(columnName(w.field));
    const type = fieldType(model, w.field);
    // SQLite compares json as text, so key order decides a match. Postgres
    // compares jsonb by value. No engine call filters on json, so refuse it.
    if (type === "json")
      throw invalid(model, w.field, "a where clause cannot filter on a json field");
    assertWhereText(model, w.field, w.value);
    const enc = (v: unknown) => encodeValue(d, type, v, model, w.field);
    switch (w.op) {
      case "eq":
        parts.push(
          w.value === null || w.value === undefined
            ? `${col} IS NULL`
            : `${col} = ${p.add(enc(w.value))}`,
        );
        break;
      case "ne":
        parts.push(
          w.value === null || w.value === undefined
            ? `${col} IS NOT NULL`
            : `${col} <> ${p.add(enc(w.value))}`,
        );
        break;
      case "in": {
        if (!Array.isArray(w.value)) throw invalid(model, w.field, "in expects an array");
        const vals = w.value.filter((v) => v !== null && v !== undefined);
        for (const v of vals) enc(v);
        if (vals.length === 0) {
          impossible = true;
          break;
        }
        // A long list binds one JSON text on SQLite and D1 (ruling 84 of plan 12d). The
        // values stay bound: json_each reads them, and no value enters the SQL text.
        if (d.lists === "json" && vals.length > IN_PARAMS_MAX)
          parts.push(
            `${col} IN (SELECT value FROM json_each(${p.add(JSON.stringify(vals.map(enc)))}))`,
          );
        else {
          const marks = vals.map((v) => p.add(enc(v)));
          // A fixed size: the last value again, which matches the rows it matches already.
          const last = enc(vals[vals.length - 1]);
          if (d.listSizes === "fixed")
            for (let i = vals.length; i < paddedSize(vals.length); i++) marks.push(p.add(last));
          parts.push(`${col} IN (${marks.join(", ")})`);
        }
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (w.value === null || w.value === undefined) {
          impossible = true;
          break;
        }
        const op = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[w.op];
        parts.push(`${col} ${op} ${p.add(enc(w.value))}`);
        break;
      }
      case "startsWith": {
        if (type !== "string" || typeof w.value !== "string" || w.value === "")
          throw invalid(model, w.field, "startsWith takes a non-empty string on a string field");
        // assertWhereText refused a lone surrogate above.
        // substr, not LIKE: SQLite's LIKE ignores the case of ASCII letters, and a
        // wildcard needs an escape. The function substr counts characters on both
        // dialects, so the match is exact (plan 12f deviation 2). No index serves
        // it: a scan.
        parts.push(`substr(${col}, 1, ${p.add([...w.value].length)}) = ${p.add(enc(w.value))}`);
        break;
      }
    }
  }
  if (impossible) return { clause: "", impossible: true };
  return { clause: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", impossible: false };
}

function validateLimit(model: ModelName, limit: number | undefined): void {
  if (limit === undefined) return;
  // A safe integer only: MySQL inlines the limit, and 1e21 prints as "1e+21".
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw invalid(model, "limit", "expected a non-negative integer");
}

export function insertStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  data: Models[M],
): Statement {
  return valuesInsert(d, model, [data]);
}

/** One INSERT of every row of `rows`, a VALUES tuple per row (ruling 57 of plan 12d). */
function valuesInsert<M extends ModelName>(
  d: Dialect,
  model: M,
  rows: readonly Models[M][],
): Statement {
  assertModel(model);
  if (rows.length === 0) throw invalid(model, "rows", "an insert needs at least one row");
  const p = new Params(d);
  const fields = fieldsOf(model);
  const tuples = rows.map((data) => {
    assertFields(model, Object.keys(data));
    const values = fields.map((f) => {
      const type = fieldType(model, f);
      const ph = p.add(
        encodeValue(d, type, (data as unknown as Record<string, unknown>)[f], model, f),
      );
      return type === "json" && d.json === "jsonb" ? jsonbCast(ph) : ph;
    });
    return `(${values.join(", ")})`;
  });
  return {
    sql: `INSERT INTO ${d.quote(TABLES[model])} (${fields.map((f) => d.quote(columnName(f))).join(", ")}) VALUES ${tuples.join(", ")}`,
    params: p.values,
  };
}

/**
 * One INSERT of every row of `rows` (ruling 57 of plan 12d). On a "json"
 * dialect the rows bind as one JSON list of tuples, and `jsonRows`
 * expands it, so the parameters do not grow with the rows (ruling 84).
 * Else a VALUES tuple per row.
 */
export function insertManyStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  rows: readonly Models[M][],
): Statement {
  if (d.lists !== "json") return valuesInsert(d, model, rows);
  assertModel(model);
  if (rows.length === 0) throw invalid(model, "rows", "an insert needs at least one row");
  const fields = fieldsOf(model);
  const tuples = rows.map((data) => {
    assertFields(model, Object.keys(data));
    const row = data as unknown as Record<string, unknown>;
    return fields.map((f) => encodeValue(d, fieldType(model, f), row[f], model, f));
  });
  return {
    sql: `INSERT INTO ${d.quote(TABLES[model])} (${fields.map((f) => d.quote(columnName(f))).join(", ")}) ${jsonRows(fields.length)}`,
    params: [JSON.stringify(tuples)],
  };
}

/**
 * The SELECT of `n` columns from the one JSON parameter `placeholder`: a
 * list of tuples, one row per tuple (ruling 84 of plan 12d). SQLite reads
 * a JSON number as an integer and a JSON string as text, so each encoded
 * value comes back as it was bound. The values never enter the SQL text.
 */
export function jsonRows(n: number, placeholder = "?"): string {
  const cols = Array.from({ length: n }, (_, i) => `json_extract(value, '$[${i}]')`);
  return `SELECT ${cols.join(", ")} FROM json_each(${placeholder})`;
}

/**
 * The bound parameters of one D1 query: 100 (D1 limits page, last updated
 * 21 April 2026, read 2026-10-24). The page applies each limit of a query
 * to each statement of a batch. So one INSERT of many rows is one query,
 * and its rows share the 100 parameters. Since ruling 84 of plan 12d a
 * D1 insert binds one JSON list, so this bound no longer sets its chunk.
 */
export const D1_BOUND_PARAMS = 100;

/**
 * The most values of an `in` list with one parameter per value: 50, half
 * the D1 bound, as `IN_CHUNK` of batch.ts. A longer list binds one JSON
 * text on a "json" dialect (ruling 84 of plan 12d). A shorter one keeps
 * the text of the statements before that ruling.
 */
export const IN_PARAMS_MAX = 50;

/**
 * The sizes of a long list and of a large insert chunk on a "fixed" dialect,
 * MySQL (ruling 85 of plan 12d). The `execute` of mysql2 keeps one server
 * prepared statement per SQL text on each connection, up to 16000. The server
 * holds at most `max_prepared_stmt_count` of them for all clients, 16382 by
 * default (MySQL 8.4 docs, read 2026-10-24). When it reaches that count, each
 * client of the server gets error 1461. A list of 51 to 2000 values, with one
 * text per size, gave up to 1950 texts of each statement kind on each
 * connection. With these sizes, a kind has at most 56 texts.
 */
export const LIST_SIZES: readonly number[] = [64, 128, 256, 512, 1000, 2000];

/**
 * The placeholders of an `in` list of `n` values on a "fixed" dialect: `n`
 * up to `IN_PARAMS_MAX`, else the first of `LIST_SIZES` that holds `n`.
 * Past the last size, the next multiple of 1000: no engine list is so long.
 */
export function paddedSize(n: number): number {
  if (n <= IN_PARAMS_MAX) return n;
  return LIST_SIZES.find((size) => size >= n) ?? Math.ceil(n / 1000) * 1000;
}

/**
 * The rows of each statement of a `createMany` of `n` rows on a "fixed"
 * dialect, in order. Each takes the largest of `LIST_SIZES` up to `max` that
 * fits the rest. The last rows go at most `IN_PARAMS_MAX` at a time. So the
 * inserts of one model have at most 55 texts. An insert cannot pad: a row twice
 * breaks the primary key.
 */
export function fixedChunks(n: number, max: number): number[] {
  const sizes = LIST_SIZES.filter((size) => size <= Math.min(max, INSERT_ROWS_MAX)).reverse();
  const out: number[] = [];
  for (let left = n; left > 0; ) {
    const size = sizes.find((x) => x <= left) ?? Math.min(left, IN_PARAMS_MAX, max);
    out.push(size);
    left -= size;
  }
  return out;
}

/**
 * The most rows of one `createMany` statement on every store: 1000. The
 * bound parameters allow more on SQLite, Postgres, and MySQL. But on
 * 2026-10-24 the MySQL 8.4 server of a test slot (768 MB) ended with exit
 * 137, out of memory, in a transaction of 13108 rows in two statements of
 * 65535 parameters. A smaller statement bounds the memory of the server.
 * The SCIM writes send at most PATCH_MEMBERS_MAX rows.
 */
export const INSERT_ROWS_MAX = 1000;

/**
 * The most values of one list of the engine in one statement: 2000. A
 * write of a SCIM group reads the added and the removed members in one
 * list, up to 1000 each (ruling 85 of plan 12d). One statement per list
 * keeps the undo of a late conflict inside the D1 budget. An insert keeps
 * its own bound, `INSERT_ROWS_MAX`.
 */
export const LIST_MAX = 2 * INSERT_ROWS_MAX;

/**
 * The most bytes of one D1 statement: 100 KB (D1 limits page, last updated
 * 21 April 2026, read 2026-10-24). The page does not say whether a bound
 * value counts. The safe reading counts the bound text too, so a JSON list
 * never passes it (ruling 84 of plan 12d).
 */
export const STATEMENT_BYTES_MAX = 100_000;

/** The most bytes of the JSON text of one list: 90 KB, so the SQL text of its statement fits beside it. */
export const LIST_BYTES_MAX = 90_000;

const utf8 = new TextEncoder();

/** The bytes of the JSON text of `v`, in UTF-8. */
export function jsonBytes(v: unknown): number {
  return utf8.encode(JSON.stringify(v) ?? "null").length;
}

/** The bytes of a statement: its SQL text and the text of each string parameter, in UTF-8. */
export function statementBytes(s: Statement): number {
  let n = utf8.encode(s.sql).length;
  for (const v of s.params) if (typeof v === "string") n += utf8.encode(v).length;
  return n;
}

/**
 * Splits `values` into lists in order (ruling 84 of plan 12d). Each holds at
 * most `max` values and at most `bytes` of JSON text by `bytesOf`. A value
 * larger than `bytes` is a list of its own.
 */
export function listChunks<T>(
  values: readonly T[],
  bytes: number = LIST_BYTES_MAX,
  bytesOf: (v: T) => number = jsonBytes,
  max: number = LIST_MAX,
): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  // The brackets of the list.
  let used = 2;
  for (const v of values) {
    // The value and its comma.
    const n = bytesOf(v) + 1;
    if (chunk.length > 0 && (chunk.length >= max || used + n > bytes)) {
      out.push(chunk);
      chunk = [];
      used = 2;
    }
    chunk.push(v);
    used += n;
  }
  if (chunk.length > 0) out.push(chunk);
  return out;
}

/**
 * The rows of one `createMany` statement under `bound` parameters: from 1
 * to `INSERT_ROWS_MAX`. A statement set whose rows bind as one JSON list
 * (`insertParams` 0) answers `INSERT_ROWS_MAX`.
 */
export function rowsPerInsertOf(st: SqlStatements, model: ModelName, bound: number): number {
  assertModel(model);
  const per = st.insertParams(model);
  if (per === 0) return INSERT_ROWS_MAX;
  return Math.max(1, Math.min(INSERT_ROWS_MAX, Math.floor(bound / per)));
}

/**
 * The statements of one `createMany`: one INSERT per chunk of
 * `rowsPerInsertOf` rows. A statement of more than `STATEMENT_BYTES_MAX`
 * bytes splits in two halves, and again, until each fits or holds one row
 * (ruling 84 of plan 12d).
 */
export function insertChunks<M extends ModelName>(
  st: SqlStatements,
  model: M,
  rows: readonly Models[M][],
  bound: number,
): Statement[] {
  const size = rowsPerInsertOf(st, model, bound);
  const out: Statement[] = [];
  const add = (part: readonly Models[M][]) => {
    const s = st.insertMany(model, part);
    if (part.length < 2 || statementBytes(s) <= STATEMENT_BYTES_MAX) {
      out.push(s);
      return;
    }
    const half = Math.ceil(part.length / 2);
    add(part.slice(0, half));
    add(part.slice(half));
  };
  for (let i = 0; i < rows.length; i += size) add(rows.slice(i, i + size));
  return out;
}

/**
 * The D1 undo of one `createMany`: a delete by `id` per list of
 * `listChunks`, so the undo of a large insert stays small (ruling 84 of
 * plan 12d). A user row keeps the rule of `undoCreate` with one statement
 * per row.
 */
export function undoCreateMany<M extends ModelName>(
  st: SqlStatements,
  model: M,
  rows: readonly Models[M][],
): Statement[] {
  if (model === "user") return rows.map((r) => st.undoCreate(model, r));
  const out: Statement[] = [];
  for (const ids of listChunks(rows.map((r) => (r as { id: string }).id))) {
    const s = st.delete(model, [{ field: "id", op: "in", value: ids } as Where<M>]);
    if (s) out.push(s);
  }
  return out;
}

/** True when each value of each raw row is JSON text as it was read: null, a string, or a number. */
export function jsonSafeRows(rows: readonly Record<string, unknown>[]): boolean {
  return rows.every((r) =>
    Object.values(r).every(
      (v) => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)),
    ),
  );
}

export function selectStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  where: Where<M>[],
  opts: FindManyOptions<M> = {},
): Statement | null {
  assertModel(model);
  const sorts = sortsOf(model, opts);
  validateLimit(model, opts.limit);
  const p = new Params(d);
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  let sql = `SELECT ${columnsOf(model).map(d.quote).join(", ")} FROM ${d.quote(TABLES[model])}${w.clause}`;
  if (sorts.length > 0) {
    const terms = sorts.map((x) => {
      const col = d.quote(columnName(x.field));
      const dir = x.dir === "asc" ? "ASC" : "DESC";
      return d.nullsOrder === "explicit" && !x.notNull
        ? `${col} IS NULL${dir === "DESC" ? " DESC" : ""}, ${col} ${dir}`
        : `${col} ${dir}`;
    });
    sql += ` ORDER BY ${terms.join(", ")}`;
  }
  // MySQL: mysql2 sends a number parameter as a double, and LIMIT refuses it.
  // The value is a checked non-negative integer, so inline text is safe.
  if (opts.limit !== undefined)
    sql += ` LIMIT ${d.limit === "inline" ? opts.limit : p.add(opts.limit)}`;
  return { sql, params: p.values };
}

export function updateStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  where: Where<M>[],
  data: Partial<Omit<Models[M], "id">>,
): Statement | null {
  assertModel(model);
  if (where.length === 0) throw invalid(model, "where", "update needs a where");
  const keys = Object.keys(data);
  if (keys.includes("id")) throw new StorageError("unknown_field", model, ["id"]);
  assertFields(model, keys);
  if (keys.length === 0) throw invalid(model, "data", "update needs at least one field");
  const p = new Params(d);
  const sets = keys.map((f) => {
    const type = fieldType(model, f);
    const ph = p.add(encodeValue(d, type, (data as Record<string, unknown>)[f], model, f));
    return `${d.quote(columnName(f))} = ${type === "json" && d.json === "jsonb" ? jsonbCast(ph) : ph}`;
  });
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  return {
    sql: `UPDATE ${d.quote(TABLES[model])} SET ${sets.join(", ")}${w.clause}`,
    params: p.values,
  };
}

export function deleteStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  where: Where<M>[],
): Statement | null {
  assertModel(model);
  if (where.length === 0) throw invalid(model, "where", "delete needs a where");
  const p = new Params(d);
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  return { sql: `DELETE FROM ${d.quote(TABLES[model])}${w.clause}`, params: p.values };
}

/**
 * The check of one stored schema version: `value` is the stored version, or
 * null when the meta table or row is missing. An older, missing, or
 * non-integer version throws schema_mismatch. A newer version is accepted: a
 * later migration must stay compatible with this adapter until the adapter is
 * updated. The gate below and each adapter's `ping` call it (plan 12h Task 8).
 */
export function assertSchemaValue(value: string | null): void {
  const found = value === null ? Number.NaN : Number(value);
  if (!Number.isInteger(found) || found < SCHEMA_VERSION) {
    throw new StorageError("schema_mismatch", "meta", [value ?? "none"]);
  }
}

/**
 * The schema version gate. It calls `read` once and keeps the result. `read`
 * returns the stored version, or null when the meta table or row is missing.
 * `assertSchemaValue` checks it. A failed check is not kept, so the
 * next call reads again. An error that `read` throws passes through unchanged,
 * so an outage never looks like "run the migrations".
 */
export function schemaVersionGate(read: () => Promise<string | null>): () => Promise<void> {
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        // Start `read` after this promise is stored, so a read that throws at
        // once still resets the gate below.
        assertSchemaValue(await Promise.resolve().then(read));
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}

/**
 * The rows the D1 undo of a create may delete: the created row by id. A
 * user created unverified is deleted only while `emailVerified` is still
 * false. On D1 another request can claim that user inside the open
 * transaction. An owner's magic link or reset verifies it and links the
 * owner's identity, session, and password to it. The undo must keep that
 * row.
 *
 * A row created verified has no such claim to guard against, so this rule
 * deletes it by id. Every user create also gets the child rule of
 * `whileNoChildRow` (plan 8b). The memory adapter runs one transaction at a
 * time and Postgres isolates it, so neither runs this. Plan 9 Task 4,
 * 2026-10-10.
 */
export function undoCreateWhere<M extends ModelName>(model: M, data: Models[M]): Where<M>[] {
  const byId = { field: "id", op: "eq", value: (data as { id: string }).id } as Where<M>;
  if (model === "user" && (data as Models["user"]).emailVerified === false)
    return [byId, { field: "emailVerified", op: "eq", value: false } as Where<M>];
  return [byId];
}

/**
 * The models whose rows name a user in `userId`, in schema order. One
 * source: the schema. The D1 undo of a user create reads it (plan 8b), so a
 * new model with a `userId` field joins the rule with no edit here.
 */
export const USER_CHILD_MODELS: readonly ModelName[] = MODEL_NAMES.filter(
  (m) => m !== "user" && Object.hasOwn(schema[m].fields, "userId"),
);

/**
 * Appends one `NOT EXISTS` term per child table to a user delete, so the
 * delete matches only while no row names the user. On D1 another request
 * can add a child row for a user inside the open transaction that created
 * the user. The undo must keep that user. Else the child row points at
 * nothing. The undo log runs in reverse.
 * The transaction's own child rows are gone before this delete runs.
 * `children` holds the table and the user id column as the statement set
 * names them.
 */
export function whileNoChildRow(
  d: Dialect,
  s: Statement,
  userId: string,
  children: readonly { table: string; column: string }[],
): Statement {
  const params = [...s.params];
  const terms = children.map((c) => {
    params.push(userId);
    return ` AND NOT EXISTS (SELECT 1 FROM ${d.quote(c.table)} WHERE ${d.quote(c.column)} = ${d.placeholder(params.length)})`;
  });
  return { sql: s.sql + terms.join(""), params };
}

/**
 * Every SQL string an adapter runs. Core's tables use `coreStatements`. A
 * package that maps the models onto other tables (plan 9, the Better Auth
 * compatibility package) passes its own, so the adapters' transaction code
 * and the D1 undo log stay in one place. Not a promise of core: the storage
 * port and the conformance suite are the contract.
 */
export interface SqlStatements {
  insert<M extends ModelName>(model: M, data: Models[M]): Statement;
  /** One INSERT of each row of `rows`, which holds at least one row (ruling 57 of plan 12d). */
  insertMany<M extends ModelName>(model: M, rows: readonly Models[M][]): Statement;
  /**
   * The bound parameters of one row of `insertMany`. 0: the rows bind as
   * one JSON list, one parameter per statement (ruling 84 of plan 12d).
   */
  insertParams(model: ModelName): number;
  select<M extends ModelName>(
    model: M,
    where: Where<M>[],
    opts?: FindManyOptions<M>,
  ): Statement | null;
  update<M extends ModelName>(
    model: M,
    where: Where<M>[],
    data: Partial<Omit<Models[M], "id">>,
  ): Statement | null;
  delete<M extends ModelName>(model: M, where: Where<M>[]): Statement | null;
  decode<M extends ModelName>(model: M, row: Record<string, unknown>): Models[M];
  /** D1 undo of an update: the raw rows the update will change, read in the same batch. */
  undoSelect<M extends ModelName>(model: M, where: Where<M>[]): Statement | null;
  /**
   * D1 undo of a create. `data` is the row the create wrote. The delete keeps
   * the rule of `undoCreateWhere`: a user created unverified is deleted only
   * while it is still unverified (plan 9 Task 4). A statement for another
   * table set must keep the same rule. Every user create, verified or not, is
   * deleted only while no row of `USER_CHILD_MODELS` names it (plan 8b).
   */
  undoCreate<M extends ModelName>(model: M, data: Models[M]): Statement;
  /**
   * D1 undo of an update. `row` is the raw row that `undoSelect` read before
   * the update, and `data` is the update's data. The undo writes back by id
   * only the columns that `data` set. On D1 another request can change other
   * columns of the row inside the open transaction (an owner's claim sets
   * `emailVerified`), and the undo must keep that change. A statement for
   * another table set must keep the same rule. Plan 9 final review M-1
   * (R-1), 2026-10-10.
   *
   * Each column goes back on its own, and only while it still holds the
   * value the update wrote. The user hold and the row locks write a value
   * back to itself. Another request can then write the row inside the open
   * transaction, such as a profile write in a before hook. A refusal must
   * keep that write (ruling 46 of plan 12k). A later write of one column
   * must not stop the restore of the other columns (ruling 47). The
   * compare is null-safe.
   */
  restoreRow<M extends ModelName>(
    model: M,
    row: Record<string, unknown>,
    data: Partial<Omit<Models[M], "id">>,
  ): Statement;
  /** D1 undo of a delete: the raw row inserted again. */
  reinsertRow(model: ModelName, row: Record<string, unknown>): Statement;
  /**
   * Optional. D1 undo of a delete of many rows: the raw rows inserted
   * again, one statement per list of `listChunks` (ruling 84 of plan 12d).
   * The rows hold the same columns. So the undo of a delete of 1000 rows
   * stays inside the query budget. Without it, the D1 adapter sends
   * `reinsertRow` per row.
   */
  reinsertRows?(model: ModelName, rows: readonly Record<string, unknown>[]): Statement[];
  /**
   * Optional. D1 undo of an update of many rows: `restoreRow` of each row,
   * one statement per list of `listChunks` (ruling 84 of plan 12d). It
   * keeps every rule of `restoreRow`. Without it, the D1 adapter sends
   * `restoreRow` per row.
   */
  restoreRows?<M extends ModelName>(
    model: M,
    rows: readonly Record<string, unknown>[],
    data: Partial<Omit<Models[M], "id">>,
  ): Statement[];
  /** A delete inside a D1 transaction, with RETURNING of every raw column the undo needs. */
  deleteReturning<M extends ModelName>(model: M, where: Where<M>[]): Statement | null;
}

/** Core's own statements on the `ta_` tables. The D1 strings are the ones the adapter built before plan 9. */
export function coreStatements(d: Dialect): SqlStatements {
  const out: SqlStatements = {
    insert(model, data) {
      return insertStatement(d, model, data);
    },
    insertMany(model, rows) {
      return insertManyStatement(d, model, rows);
    },
    insertParams(model) {
      assertModel(model);
      return d.lists === "json" ? 0 : fieldsOf(model).length;
    },
    select(model, where, opts) {
      return selectStatement(d, model, where, opts);
    },
    update(model, where, data) {
      return updateStatement(d, model, where, data);
    },
    delete(model, where) {
      return deleteStatement(d, model, where);
    },
    decode(model, row) {
      return decodeRow(d, model, row);
    },
    undoSelect(model, where) {
      return selectStatement(d, model, where);
    },
    undoCreate(model, data) {
      const s = deleteStatement(d, model, undoCreateWhere(model, data));
      if (!s) throw new Error("undoCreate: an eq filter always compiles");
      if (model !== "user") return s;
      return whileNoChildRow(
        d,
        s,
        (data as Models["user"]).id,
        USER_CHILD_MODELS.map((m) => ({ table: TABLES[m], column: columnName("userId") })),
      );
    },
    restoreRow(model, row, data) {
      // Only the columns the update set, through the same field-to-column
      // map as `updateStatement`, by id. Each column goes back on its own,
      // and only while it holds the value the update wrote. See the
      // interface comment.
      const fields = Object.keys(data);
      assertFields(model, fields);
      const p = new Params(d);
      const sets = fields.map((f) => {
        const c = columnName(f);
        const q = d.quote(c);
        const type = fieldType(model, f);
        const ph = p.add(encodeValue(d, type, (data as Record<string, unknown>)[f], model, f));
        const written = type === "json" && d.json === "jsonb" ? jsonbCast(ph) : ph;
        return `${q} = CASE WHEN ${q} ${d.nullSafeEq} ${written} THEN ${p.add(row[c])} ELSE ${q} END`;
      });
      return {
        sql: `UPDATE ${d.quote(TABLES[model])} SET ${sets.join(", ")} WHERE ${d.quote("id")} = ${p.add(row.id)}`,
        params: p.values,
      };
    },
    reinsertRow(model, row) {
      const cols = Object.keys(row);
      return {
        sql: `INSERT INTO ${d.quote(TABLES[model])} (${cols.map(d.quote).join(", ")}) VALUES (${cols.map((_, i) => d.placeholder(i + 1)).join(", ")})`,
        params: cols.map((c) => row[c]),
      };
    },
    reinsertRows(model, rows) {
      const first = rows[0];
      if (d.lists !== "json" || first === undefined || !jsonSafeRows(rows))
        return rows.map((r) => out.reinsertRow(model, r));
      const cols = Object.keys(first);
      return listChunks(rows.map((r) => cols.map((c) => r[c]))).map((chunk) => ({
        sql: `INSERT INTO ${d.quote(TABLES[model])} (${cols.map(d.quote).join(", ")}) ${jsonRows(cols.length)}`,
        params: [JSON.stringify(chunk)],
      }));
    },
    restoreRows(model, rows, data) {
      if (d.lists !== "json" || rows.length < 2 || !jsonSafeRows(rows))
        return rows.map((r) => out.restoreRow(model, r, data));
      // The rule of restoreRow, with the old values of each row from one JSON list: the
      // list joins the table by id. Each column goes back on its own, and only while it
      // holds the value the update wrote.
      const fields = Object.keys(data);
      assertFields(model, fields);
      const p = new Params(d);
      const t = d.quote(TABLES[model]);
      const sets = fields.map((f, i) => {
        const q = d.quote(columnName(f));
        const ph = p.add(
          encodeValue(d, fieldType(model, f), (data as Record<string, unknown>)[f], model, f),
        );
        return `${q} = CASE WHEN ${t}.${q} ${d.nullSafeEq} ${ph} THEN u.c${i + 1} ELSE ${t}.${q} END`;
      });
      const cols = ["id", ...fields.map(columnName)];
      const pick = cols.map((_, i) => `json_extract(value, '$[${i}]') AS c${i}`);
      return listChunks(rows.map((r) => cols.map((c) => r[c]))).map((chunk) => ({
        sql: `UPDATE ${t} SET ${sets.join(", ")} FROM (SELECT ${pick.join(", ")} FROM json_each(${d.placeholder(p.values.length + 1)})) AS u WHERE ${t}.${d.quote("id")} = u.c0`,
        params: [...p.values, JSON.stringify(chunk)],
      }));
    },
    deleteReturning(model, where) {
      const s = deleteStatement(d, model, where);
      return (
        s && {
          sql: `${s.sql} RETURNING ${columnsOf(model).map(d.quote).join(", ")}`,
          params: s.params,
        }
      );
    },
  };
  return out;
}
