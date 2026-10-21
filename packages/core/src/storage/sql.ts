import { type FieldType, type ModelName, type Models, SCHEMA_VERSION, schema } from "../schema.js";
import { type FindManyOptions, StorageError, type Where } from "./port.js";

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
      return value;
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
        parts.push(`${col} IN (${vals.map((v) => p.add(enc(v))).join(", ")})`);
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
  assertModel(model);
  assertFields(model, Object.keys(data));
  const p = new Params(d);
  const fields = fieldsOf(model);
  const values = fields.map((f) => {
    const type = fieldType(model, f);
    const ph = p.add(
      encodeValue(d, type, (data as unknown as Record<string, unknown>)[f], model, f),
    );
    return type === "json" && d.json === "jsonb" ? jsonbCast(ph) : ph;
  });
  return {
    sql: `INSERT INTO ${d.quote(TABLES[model])} (${fields.map((f) => d.quote(columnName(f))).join(", ")}) VALUES (${values.join(", ")})`,
    params: p.values,
  };
}

export function selectStatement<M extends ModelName>(
  d: Dialect,
  model: M,
  where: Where<M>[],
  opts: FindManyOptions<M> = {},
): Statement | null {
  assertModel(model);
  const sorts = opts.sort === undefined ? [] : Array.isArray(opts.sort) ? opts.sort : [opts.sort];
  assertFields(
    model,
    sorts.map((x) => x.field),
  );
  validateLimit(model, opts.limit);
  const p = new Params(d);
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  let sql = `SELECT ${columnsOf(model).map(d.quote).join(", ")} FROM ${d.quote(TABLES[model])}${w.clause}`;
  if (sorts.length > 0) {
    const terms = sorts.map((x) => {
      const col = d.quote(columnName(x.field));
      const dir = x.dir === "asc" ? "ASC" : "DESC";
      return d.nullsOrder === "explicit"
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
  /** A delete inside a D1 transaction, with RETURNING of every raw column the undo needs. */
  deleteReturning<M extends ModelName>(model: M, where: Where<M>[]): Statement | null;
}

/** Core's own statements on the `ta_` tables. The D1 strings are the ones the adapter built before plan 9. */
export function coreStatements(d: Dialect): SqlStatements {
  return {
    insert(model, data) {
      return insertStatement(d, model, data);
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
}
