import { type ModelName, StorageError, schema, type Where } from "@tempo-auth/core";
import {
  assertFields,
  assertModel,
  encodeValue,
  POSTGRES,
  SQLITE,
  type SqlStatements,
  type Statement,
  undoCreateWhere,
} from "@tempo-auth/core/sql";
import { type AnyModelMap, MAPPING } from "./mapping.js";
import { FILLED_DATES, sqliteIsoText } from "./migration.js";
import { type BetterAuthTable, type Names, TABLE_FIELDS } from "./names.js";

type Row = Record<string, unknown>;
type FieldType = "string" | "boolean" | "integer" | "date" | "json";
const MAP = MAPPING as unknown as Record<ModelName, AnyModelMap>;

function def(model: ModelName, field: string): { type: FieldType; nullable: boolean } {
  const d = (schema[model].fields as Record<string, { type: FieldType; nullable?: boolean }>)[
    field
  ];
  return { type: d?.type ?? "string", nullable: d?.nullable === true };
}

function invalid(model: ModelName, field: string, why: string): StorageError {
  const e = new StorageError("invalid_argument", model, [field]);
  e.message = `${e.message}: ${why}`;
  return e;
}

export function base64UrlToStd(text: string): string {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

export function base64StdToUrl(text: string): string {
  return text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** ISO text in UTC, so a Drizzle client with the timestamp parsers off and a plain client read the same value. */
const pgDate = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const PG_KEY_RE = /^Key \((.+?)\)=\(/;
const SQLITE_UNIQUE_RE = /UNIQUE constraint failed: ((?:[\w"]+\.[\w"]+)(?:, [\w"]+\.[\w"]+)*)/;

export interface CompatStatements extends SqlStatements {
  toStorageError(model: ModelName, err: unknown): StorageError | null;
}

/**
 * The statements for core's models on the Better Auth tables. They keep
 * every rule of the storage port (port.ts): the null rules, the sort rules,
 * the write rules, the argument rules. Core's conformance suite is the check.
 */
export function compatStatements(dialect: "postgres" | "sqlite", names: Names): CompatStatements {
  const d = dialect === "postgres" ? POSTGRES : SQLITE;
  const pg = dialect === "postgres";

  class Params {
    readonly values: unknown[] = [];
    add(v: unknown, type?: FieldType): string {
      this.values.push(v);
      const p = d.placeholder(this.values.length);
      return pg && type === "date" ? `${p}::timestamptz` : p;
    }
  }

  const table = (model: ModelName) => names.table(MAP[model].table);
  const column = (model: ModelName, field: string) =>
    names.column(MAP[model].table, MAP[model].fields[field]?.column ?? field);
  const qualified = (model: ModelName, field: string) => `${table(model)}.${column(model, field)}`;
  /**
   * SQLite: the value of a field in a select, a where, and a sort. A `ta`
   * date that migration 0001 fills from a Better Auth column reads that
   * column when it is null: SQLite's ADD COLUMN takes no expression default,
   * so a row that another writer adds after the migration has no `ta` value.
   * strftime gives the ISO millisecond text core writes, also for a Better
   * Auth date in SQLite's 'YYYY-MM-DD HH:MM:SS' form. Postgres has a column
   * default instead (migration 0001).
   */
  const value = (model: ModelName, field: string) => {
    const c = column(model, field);
    if (pg) return c;
    const t = MAP[model].table;
    const baField = MAP[model].fields[field]?.column ?? field;
    const filled = FILLED_DATES.find((a) => a.table === t && a.field === baField);
    return filled ? `COALESCE(${c}, ${sqliteIsoText(names.column(t, filled.from))})` : c;
  };
  /**
   * The Better Auth field of a column name that SQLite reports. SQLite
   * matches names without case, so a configured name and the DDL can differ
   * in case and every statement still runs; the lookup must then match too.
   */
  const fieldOfRaw = (t: BetterAuthTable, raw: string): string | null =>
    names.fieldOf(t, raw) ??
    (pg
      ? null
      : (TABLE_FIELDS[t].find((f) => names.rawColumn(t, f).toLowerCase() === raw.toLowerCase()) ??
        null));
  const quoteRaw = (c: string) => `"${c.replaceAll('"', '""')}"`;

  function encode(model: ModelName, field: string, value: unknown): unknown {
    const { type } = def(model, field);
    const codec = MAP[model].fields[field]?.codec;
    const given = codec === "nullAsEmpty" && (value === null || value === undefined) ? "" : value;
    // core's encodeValue checks the type and refuses NUL; it answers JSON text and SQLite 0 or 1.
    const v = encodeValue(d, type, given, model, field);
    if (v === null) return null;
    if (type === "date") return (given as Date).toISOString();
    if (codec === "base64Std") return base64UrlToStd(v as string);
    return v;
  }

  function decodeField(model: ModelName, field: string, raw: unknown): unknown {
    const { type, nullable } = def(model, field);
    const codec = MAP[model].fields[field]?.codec;
    let v: unknown = raw ?? null;
    if (v !== null) {
      if (type === "boolean") v = typeof v === "number" ? v !== 0 : v === true;
      else if (type === "date") v = new Date(v as string);
      else if (type === "json") v = typeof v === "string" ? JSON.parse(v) : v;
      else if (type === "integer") v = typeof v === "string" ? Number(v) : v;
      if ((codec === "nullAsEmpty" || codec === "emptyAsNull") && v === "") v = null;
      else if (codec === "base64Std") v = base64StdToUrl(v as string);
    }
    // A Better Auth row written after the migration by Better Auth itself (a rollback) has no `ta` value.
    if (v === null && !nullable) throw new StorageError("schema_mismatch", model, [field]);
    return v;
  }

  function scope(model: ModelName): string | null {
    const s = MAP[model].scope;
    if (!s) return null;
    const c = names.column(MAP[model].table, s.column);
    if (s.op === "notNull") return `${c} IS NOT NULL`;
    return `${c} ${s.op === "eq" ? "=" : "<>"} '${s.value}'`;
  }

  function compileWhere(
    model: ModelName,
    where: Where<ModelName>[],
    p: Params,
  ): { clause: string; impossible: boolean } {
    assertFields(
      model,
      where.map((w) => w.field),
    );
    const parts: string[] = [];
    const sc = scope(model);
    if (sc) parts.push(sc);
    // Validate every clause before answering "never matches", as core's builder does.
    let impossible = false;
    for (const w of where) {
      const { type } = def(model, w.field);
      if (type === "json")
        throw invalid(model, w.field, "a where clause cannot filter on a json field");
      const codec = MAP[model].fields[w.field]?.codec;
      if (codec === "base64Std" || codec === "emptyAsNull") {
        throw invalid(
          model,
          w.field,
          "a where clause cannot filter on this field in the Better Auth tables",
        );
      }
      const empty = codec === "nullAsEmpty";
      const c = value(model, w.field);
      const isNull = (v: unknown) => v === null || v === undefined || (empty && v === "");
      const enc = (v: unknown) => p.add(encode(model, w.field, v), type);
      switch (w.op) {
        case "eq":
          parts.push(
            isNull(w.value) ? (empty ? `${c} = ''` : `${c} IS NULL`) : `${c} = ${enc(w.value)}`,
          );
          break;
        case "ne":
          if (isNull(w.value)) parts.push(empty ? `${c} <> ''` : `${c} IS NOT NULL`);
          else {
            parts.push(`${c} <> ${enc(w.value)}`);
            if (empty) parts.push(`${c} <> ''`);
          }
          break;
        case "in": {
          if (!Array.isArray(w.value)) throw invalid(model, w.field, "in expects an array");
          const vals = w.value.filter((v) => !isNull(v));
          for (const v of vals) encode(model, w.field, v);
          if (vals.length === 0) {
            impossible = true;
            break;
          }
          parts.push(`${c} IN (${vals.map(enc).join(", ")})`);
          break;
        }
        default: {
          if (isNull(w.value)) {
            impossible = true;
            break;
          }
          const op = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[w.op];
          parts.push(`${c} ${op} ${enc(w.value)}`);
          if (empty) parts.push(`${c} <> ''`);
        }
      }
    }
    if (impossible) return { clause: "", impossible: true };
    return { clause: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", impossible: false };
  }

  function fieldsFor(model: ModelName, rawColumns: string[]): string[] {
    const t = MAP[model].table;
    const baFields = rawColumns.map((c) => fieldOfRaw(t, c));
    if (baFields.some((f) => f === null)) return [];
    if (
      t === "account" &&
      baFields.length === 2 &&
      baFields.includes("issuer") &&
      baFields.includes("accountId")
    ) {
      if (model === "password") return ["userId"];
      if (model === "identity") return ["provider", "subject"];
      return [];
    }
    const entries = Object.entries(MAP[model].fields);
    return baFields
      .map((f) => entries.find(([, m]) => m.column === f)?.[0])
      .filter((f): f is string => f !== undefined);
  }

  const st: CompatStatements = {
    insert(model, data) {
      assertModel(model);
      assertFields(model, Object.keys(data));
      const map = MAP[model];
      const p = new Params();
      const cols: string[] = [];
      const vals: string[] = [];
      for (const field of Object.keys(map.fields)) {
        cols.push(column(model, field));
        vals.push(
          p.add(encode(model, field, (data as unknown as Row)[field]), def(model, field).type),
        );
      }
      for (const [c, v] of Object.entries(map.insertExtras?.(data as unknown as Row) ?? {})) {
        cols.push(names.column(map.table, c));
        vals.push(p.add(v));
      }
      return {
        sql: `INSERT INTO ${table(model)} (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
        params: p.values,
      };
    },
    select(model, where, opts = {}) {
      assertModel(model);
      const sorts =
        opts.sort === undefined ? [] : Array.isArray(opts.sort) ? opts.sort : [opts.sort];
      assertFields(
        model,
        sorts.map((s) => s.field),
      );
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
        throw invalid(model, "limit", "expected a non-negative integer");
      }
      const p = new Params();
      const w = compileWhere(model, where as Where<ModelName>[], p);
      if (w.impossible) return null;
      const list = Object.keys(MAP[model].fields)
        .map(
          (f) =>
            `${pg && def(model, f).type === "date" ? pgDate(column(model, f)) : value(model, f)} AS "${f}"`,
        )
        .join(", ");
      let sql = `SELECT ${list} FROM ${table(model)}${w.clause}`;
      if (sorts.length > 0) {
        const terms = sorts.map((s) => {
          // Qualified, so Postgres sorts by the column and not by the output alias of the same name.
          const raw = pg ? qualified(model, s.field) : value(model, s.field);
          const e =
            MAP[model].fields[s.field]?.codec === "nullAsEmpty" ? `NULLIF(${raw}, '')` : raw;
          const dir = s.dir === "asc" ? "ASC" : "DESC";
          return pg ? `${e} ${dir}` : `${e} IS NULL${dir === "DESC" ? " DESC" : ""}, ${e} ${dir}`;
        });
        sql += ` ORDER BY ${terms.join(", ")}`;
      }
      if (opts.limit !== undefined) sql += ` LIMIT ${p.add(opts.limit)}`;
      return { sql, params: p.values };
    },
    update(model, where, data) {
      assertModel(model);
      if (where.length === 0) throw invalid(model, "where", "update needs a where");
      const keys = Object.keys(data);
      if (keys.includes("id")) throw new StorageError("unknown_field", model, ["id"]);
      assertFields(model, keys);
      if (keys.length === 0) throw invalid(model, "data", "update needs at least one field");
      const map = MAP[model];
      const p = new Params();
      const sets = keys.map(
        (f) =>
          `${column(model, f)} = ${p.add(encode(model, f, (data as Row)[f]), def(model, f).type)}`,
      );
      for (const [c, v] of Object.entries(map.updateExtras?.(data as Row) ?? {}))
        sets.push(`${names.column(map.table, c)} = ${p.add(v)}`);
      const w = compileWhere(model, where as Where<ModelName>[], p);
      if (w.impossible) return null;
      return { sql: `UPDATE ${table(model)} SET ${sets.join(", ")}${w.clause}`, params: p.values };
    },
    delete(model, where) {
      assertModel(model);
      if (where.length === 0) throw invalid(model, "where", "delete needs a where");
      const p = new Params();
      const w = compileWhere(model, where as Where<ModelName>[], p);
      if (w.impossible) return null;
      return { sql: `DELETE FROM ${table(model)}${w.clause}`, params: p.values };
    },
    decode(model, row) {
      const out: Row = {};
      for (const f of Object.keys(MAP[model].fields)) out[f] = decodeField(model, f, row[f]);
      return out as never;
    },
    undoSelect(model, where) {
      assertModel(model);
      const p = new Params();
      const w = compileWhere(model, where as Where<ModelName>[], p);
      if (w.impossible) return null;
      return { sql: `SELECT * FROM ${table(model)}${w.clause}`, params: p.values };
    },
    undoCreate(model, data) {
      // Core's rule (Task 4): a user created unverified is deleted only while
      // it is still unverified, so a claim's verified row survives the undo.
      const s = st.delete(model, undoCreateWhere(model, data));
      if (!s) throw new Error("undoCreate: an eq filter always compiles");
      return s;
    },
    restoreRow(model, row) {
      // The row comes from SELECT *, so its keys are the DDL's spelling. On
      // SQLite that can differ in case from the configured id name.
      const t = MAP[model].table;
      const idKey =
        Object.keys(row).find((c) => fieldOfRaw(t, c) === "id") ?? names.rawColumn(t, "id");
      const cols = Object.keys(row).filter((c) => c !== idKey);
      return {
        sql: `UPDATE ${table(model)} SET ${cols.map((c, i) => `${quoteRaw(c)} = ${d.placeholder(i + 1)}`).join(", ")} WHERE ${column(model, "id")} = ${d.placeholder(cols.length + 1)}`,
        params: [...cols.map((c) => row[c]), row[idKey]],
      };
    },
    reinsertRow(model, row) {
      const cols = Object.keys(row);
      return {
        sql: `INSERT INTO ${table(model)} (${cols.map(quoteRaw).join(", ")}) VALUES (${cols.map((_, i) => d.placeholder(i + 1)).join(", ")})`,
        params: cols.map((c) => row[c]),
      };
    },
    deleteReturning(model, where) {
      const s = st.delete(model, where);
      return s && { sql: `${s.sql} RETURNING *`, params: s.params };
    },
    toStorageError(model, err) {
      if (!(err instanceof Error)) return null;
      let raw: string[];
      if (pg) {
        const e = err as Error & { code?: string; detail?: string };
        if (e.code !== "23505") return null;
        const m = PG_KEY_RE.exec(e.detail ?? "");
        raw = m?.[1] ? m[1].split(", ").map((c) => c.replace(/^"|"$/g, "")) : [];
      } else {
        const m = SQLITE_UNIQUE_RE.exec(err.message);
        if (!m?.[1]) return null;
        raw = m[1]
          .split(", ")
          .map((pair) => pair.slice(pair.lastIndexOf(".") + 1).replace(/^"|"$/g, ""));
      }
      return new StorageError("unique_violation", model, fieldsFor(model, raw));
    },
  };
  return st;
}

export type { Statement };
