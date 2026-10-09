import { type FieldType, type ModelName, type Models, schema } from "../schema.js";
import { type FindManyOptions, StorageError, type Where } from "./port.js";

export interface Dialect {
  name: "sqlite" | "postgres";
  /** 1-based parameter placeholder. */
  placeholder(i: number): string;
  /** "explicit" adds an IS NULL term so nulls sort last ascending and first descending. "native" already does. */
  nullsOrder: "explicit" | "native";
  json: "text" | "jsonb";
}

export const SQLITE: Dialect = {
  name: "sqlite",
  placeholder: () => "?",
  nullsOrder: "explicit",
  json: "text",
};

export const POSTGRES: Dialect = {
  name: "postgres",
  placeholder: (i) => `$${i}`,
  nullsOrder: "native",
  json: "jsonb",
};

export const META_TABLE = "ta_meta";
export const SCHEMA_VERSION_KEY = "schema_version";

const MODEL_NAMES = Object.keys(schema) as ModelName[];

/** The one source for table names. */
export const TABLES: Record<ModelName, string> = Object.fromEntries(
  MODEL_NAMES.map((m) => [m, `ta_${m}`]),
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
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        throw invalid(model, field, "expected an integer");
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw invalid(model, field, "expected a boolean");
      return d.name === "sqlite" ? (value ? 1 : 0) : value;
    case "date":
      if (!(value instanceof Date) || Number.isNaN(value.getTime()))
        throw invalid(model, field, "expected a valid Date");
      return d.name === "sqlite" ? value.getTime() : value;
    case "json":
      if (typeof value !== "object") throw invalid(model, field, "expected an object");
      return JSON.stringify(value);
  }
}

function decodeValue(_d: Dialect, type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "boolean":
      return typeof value === "number" ? value !== 0 : Boolean(value);
    case "date":
      return value instanceof Date
        ? value
        : new Date(typeof value === "string" ? value : Number(value));
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
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
  for (const w of where) {
    const col = columnName(w.field);
    const type = fieldType(model, w.field);
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
        if (vals.length === 0) return { clause: "", impossible: true };
        parts.push(`${col} IN (${vals.map((v) => p.add(enc(v))).join(", ")})`);
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (w.value === null || w.value === undefined) return { clause: "", impossible: true };
        const op = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[w.op];
        parts.push(`${col} ${op} ${p.add(enc(w.value))}`);
        break;
      }
    }
  }
  return { clause: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", impossible: false };
}

function validateLimit(model: ModelName, limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 0)
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
    return type === "json" && d.json === "jsonb" ? `${ph}::jsonb` : ph;
  });
  return {
    sql: `INSERT INTO ${TABLES[model]} (${fields.map(columnName).join(", ")}) VALUES (${values.join(", ")})`,
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
  if (opts.sort) assertFields(model, [opts.sort.field]);
  validateLimit(model, opts.limit);
  const p = new Params(d);
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  let sql = `SELECT ${columnsOf(model).join(", ")} FROM ${TABLES[model]}${w.clause}`;
  if (opts.sort) {
    const col = columnName(opts.sort.field);
    const dir = opts.sort.dir === "asc" ? "ASC" : "DESC";
    sql +=
      d.nullsOrder === "explicit"
        ? ` ORDER BY ${col} IS NULL${dir === "DESC" ? " DESC" : ""}, ${col} ${dir}`
        : ` ORDER BY ${col} ${dir}`;
  }
  if (opts.limit !== undefined) sql += ` LIMIT ${p.add(opts.limit)}`;
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
    return `${columnName(f)} = ${type === "json" && d.json === "jsonb" ? `${ph}::jsonb` : ph}`;
  });
  const w = compileWhere(d, model, where, p);
  if (w.impossible) return null;
  return { sql: `UPDATE ${TABLES[model]} SET ${sets.join(", ")}${w.clause}`, params: p.values };
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
  return { sql: `DELETE FROM ${TABLES[model]}${w.clause}`, params: p.values };
}
