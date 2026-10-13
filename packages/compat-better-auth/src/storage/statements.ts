import { toStorageError as d1StorageError } from "@tempo-auth/adapter-d1";
import { toStorageError as postgresStorageError } from "@tempo-auth/adapter-postgres";
import {
  type ModelName,
  PENDING_HASH_PREFIX,
  StorageError,
  schema,
  type Where,
} from "@tempo-auth/core";
import {
  assertFields,
  assertModel,
  columnName,
  coreStatements,
  encodeValue,
  POSTGRES,
  SQLITE,
  type SqlStatements,
  type Statement,
  TABLES,
  USER_CHILD_MODELS,
  undoCreateWhere,
  whileNoChildRow,
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

/**
 * SQLite's own date text, `YYYY-MM-DD HH:MM:SS` with an optional fraction and
 * no zone. SQLite's date functions read it as UTC; JavaScript's Date reads it
 * as local time. A Better Auth row written by SQL (`CURRENT_TIMESTAMP`) has
 * it. The read turns it into ISO text in UTC first (plan 9b2).
 */
const SQLITE_SPACE_DATE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/**
 * What a `credential` account row with a null `password` reads as (plan
 * 9b2). Better Auth 1.7.2 never writes such a row; a hand-edited table can.
 * Before plan 9b2 the row read as schema_mismatch, so the sign-in and the
 * reset answered 500. Core treats a row with the pending prefix as no
 * password row (engine/password.ts): the sign-in runs the dummy verify and
 * answers invalid_credentials, and a reset writes a real hash over it. No
 * seam parses this text, so no password matches it.
 */
export const NULL_PASSWORD_HASH = `${PENDING_HASH_PREFIX}null-password`;
/** The line the statements log once per storage for such a row, followed by the account id. */
export const NULL_PASSWORD_LOG =
  "tempo-auth compat: a credential account row has no password; it reads as no password row";
const PG_KEY_RE = /^Key \((.+?)\)=\(/;
const SQLITE_UNIQUE_RE = /UNIQUE constraint failed: ((?:[\w"]+\.[\w"]+)(?:, [\w"]+\.[\w"]+)*)/;

export interface CompatStatements extends SqlStatements {
  toStorageError(model: ModelName, err: unknown): StorageError | null;
}

/**
 * The core models with no Better Auth table: `MappedModel` in mapping.ts
 * leaves them out. This storage holds no row of them. A read answers empty,
 * as for a where that never matches, so `sweepExpired` counts 0 and
 * `caller` answers null for a `tk_` bearer. A create throws `unknown_model`,
 * so a write never vanishes in silence. Plan 8b, 2026-10-11.
 */
export const UNMAPPED_MODELS: ReadonlySet<ModelName> = new Set<ModelName>(["apiToken"]);

function withoutUnmapped(st: CompatStatements): CompatStatements {
  const none = (model: ModelName) => UNMAPPED_MODELS.has(model);
  const refuse = (model: ModelName): never => {
    throw new StorageError("unknown_model", model);
  };
  return {
    ...st,
    insert(model, data) {
      return none(model) ? refuse(model) : st.insert(model, data);
    },
    select(model, where, opts) {
      return none(model) ? null : st.select(model, where, opts);
    },
    update(model, where, data) {
      return none(model) ? null : st.update(model, where, data);
    },
    delete(model, where) {
      return none(model) ? null : st.delete(model, where);
    },
    decode(model, row) {
      return none(model) ? refuse(model) : st.decode(model, row);
    },
    undoSelect(model, where) {
      return none(model) ? null : st.undoSelect(model, where);
    },
    undoCreate(model, data) {
      return none(model) ? refuse(model) : st.undoCreate(model, data);
    },
    restoreRow(model, row, data) {
      return none(model) ? refuse(model) : st.restoreRow(model, row, data);
    },
    reinsertRow(model, row) {
      return none(model) ? refuse(model) : st.reinsertRow(model, row);
    },
    deleteReturning(model, where) {
      return none(model) ? null : st.deleteReturning(model, where);
    },
  };
}

/**
 * The core models that keep core's own table in this storage (plan 9f).
 * Better Auth has no table that fits them, so migration 0003 creates core's
 * `ta_totp` and `ta_trusted_device` beside the Better Auth tables, with
 * core's names, and core's own statements and error mapping serve them. The
 * Better Auth `twoFactor` table and `user.twoFactorEnabled` are neither read
 * nor written.
 */
export const CORE_TABLE_MODELS: ReadonlySet<ModelName> = new Set<ModelName>([
  "totp",
  "trustedDevice",
  // Plan 9g: migration 0004 creates them. The Better Auth jwks table and the
  // tables of its OAuth plugins are neither read nor written.
  "jwk",
  "oauthClient",
  "oauthConsent",
  "oauthToken",
]);

function withCoreTables(st: CompatStatements, dialect: "postgres" | "sqlite"): CompatStatements {
  const core = coreStatements(dialect === "postgres" ? POSTGRES : SQLITE);
  // The adapters' own mapping of a unique error on a ta_ table: one copy of each rule.
  const coreError = dialect === "postgres" ? postgresStorageError : d1StorageError;
  const own = (model: ModelName) => CORE_TABLE_MODELS.has(model);
  return {
    insert(model, data) {
      return own(model) ? core.insert(model, data) : st.insert(model, data);
    },
    select(model, where, opts) {
      return own(model) ? core.select(model, where, opts) : st.select(model, where, opts);
    },
    update(model, where, data) {
      return own(model) ? core.update(model, where, data) : st.update(model, where, data);
    },
    delete(model, where) {
      return own(model) ? core.delete(model, where) : st.delete(model, where);
    },
    decode(model, row) {
      return own(model) ? core.decode(model, row) : st.decode(model, row);
    },
    undoSelect(model, where) {
      return own(model) ? core.undoSelect(model, where) : st.undoSelect(model, where);
    },
    undoCreate(model, data) {
      return own(model) ? core.undoCreate(model, data) : st.undoCreate(model, data);
    },
    restoreRow(model, row, data) {
      return own(model) ? core.restoreRow(model, row, data) : st.restoreRow(model, row, data);
    },
    reinsertRow(model, row) {
      return own(model) ? core.reinsertRow(model, row) : st.reinsertRow(model, row);
    },
    deleteReturning(model, where) {
      return own(model) ? core.deleteReturning(model, where) : st.deleteReturning(model, where);
    },
    toStorageError(model, err) {
      return own(model) ? coreError(model, err) : st.toStorageError(model, err);
    },
  };
}

/**
 * The statements for core's models on the Better Auth tables. They keep
 * every rule of the storage port (port.ts): the null rules, the sort rules,
 * the write rules, the argument rules. Core's conformance suite is the check.
 */
export function compatStatements(dialect: "postgres" | "sqlite", names: Names): CompatStatements {
  const d = dialect === "postgres" ? POSTGRES : SQLITE;
  const pg = dialect === "postgres";
  // One log line per storage for a null credential password: a hand-edited table can hold many.
  let loggedNullPassword = false;

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
      else if (type === "date") {
        // Only text can be in the space form. A driver's Date or a number goes
        // to `new Date` as it is: `String(v)` would drop a Date's milliseconds
        // and make a number unreadable (M-2 of the plan 9b2 final review).
        // Any other type (a boolean, an object) is no date: `new Date(true)`
        // would read as 1 ms after the epoch (fix round 2).
        if (typeof v !== "string" && typeof v !== "number" && !(v instanceof Date))
          throw new StorageError("schema_mismatch", model, [field]);
        const space = typeof v === "string" ? SQLITE_SPACE_DATE_RE.exec(v) : null;
        const at = new Date(space ? `${space[1]}T${space[2]}${(space[3] ?? "").slice(0, 4)}Z` : v);
        // A date core cannot read would compare as NaN, so an expiry would never pass.
        if (Number.isNaN(at.getTime())) throw new StorageError("schema_mismatch", model, [field]);
        v = at;
      } else if (type === "json") {
        // App SQL can write any text here. Name the model and the field, as
        // for any other value core cannot read (final review L-10).
        try {
          v = typeof v === "string" ? JSON.parse(v) : v;
        } catch {
          throw new StorageError("schema_mismatch", model, [field]);
        }
      } else if (type === "integer") v = typeof v === "string" ? Number(v) : v;
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
      let r = row;
      if (model === "password" && (row.hash === null || row.hash === undefined)) {
        if (!loggedNullPassword) {
          loggedNullPassword = true;
          console.error(`${NULL_PASSWORD_LOG} (account ${String(row.id)})`);
        }
        r = { ...row, hash: NULL_PASSWORD_HASH };
      }
      const out: Row = {};
      for (const f of Object.keys(MAP[model].fields)) out[f] = decodeField(model, f, r[f]);
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
      if (model !== "user") return s;
      // Core's rule (plan 8b): only while no child row names the user. The
      // account table holds both the identity and the password rows, so it is
      // one term. An unmapped model has no table to check.
      const children = new Map<string, string>();
      for (const m of USER_CHILD_MODELS) {
        if (UNMAPPED_MODELS.has(m)) continue;
        // A core table model keeps core's table and column names (plan 9f).
        const own = CORE_TABLE_MODELS.has(m);
        const t = own ? TABLES[m] : table(m);
        // The skip is safe only while the models that share a table map `userId`
        // to the same column. Identity and password do today.
        if (children.has(t)) continue;
        children.set(t, own ? columnName("userId") : column(m, "userId"));
      }
      return whileNoChildRow(
        d,
        s,
        (data as { id: string }).id,
        [...children].map(([t, c]) => ({ table: t, column: c })),
      );
    },
    restoreRow(model, row, data) {
      // The row comes from SELECT *, so its keys are the DDL's spelling. On
      // SQLite that can differ in case from the configured names.
      const map = MAP[model];
      const t = map.table;
      const idKey =
        Object.keys(row).find((c) => fieldOfRaw(t, c) === "id") ?? names.rawColumn(t, "id");
      // Core's rule (`SqlStatements.restoreRow`): only the columns the update
      // set, the column of each field of `data` and each `updateExtras`
      // column, so a claim's change to another column stays (final review M-1).
      const set = [
        ...Object.keys(data).map((f) => map.fields[f]?.column ?? f),
        ...Object.keys(map.updateExtras?.(data as Row) ?? {}),
      ];
      const cols = set.map((f) => {
        const c = Object.keys(row).find((k) => k !== idKey && fieldOfRaw(t, k) === f);
        // The update wrote this column, so the SELECT * before it read it.
        if (c === undefined) throw new StorageError("schema_mismatch", model, [f]);
        return c;
      });
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
  return withoutUnmapped(withCoreTables(st, dialect));
}

export type { Statement };
