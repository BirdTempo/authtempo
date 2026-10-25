import { toStorageError as d1StorageError } from "@authtempo/adapter-d1";
import { toStorageError as postgresStorageError } from "@authtempo/adapter-postgres";
import {
  type ModelName,
  type Models,
  PENDING_HASH_PREFIX,
  StorageError,
  schema,
  type Where,
} from "@authtempo/core";
import {
  assertFields,
  assertModel,
  assertWhereText,
  columnName,
  coreStatements,
  encodeValue,
  IN_PARAMS_MAX,
  jsonRows,
  jsonSafeRows,
  listChunks,
  POSTGRES,
  SQLITE,
  type SqlStatements,
  type Statement,
  sortsOf,
  TABLES,
  USER_CHILD_MODELS,
  undoCreateWhere,
  wellFormed,
  whileNoChildRow,
} from "@authtempo/core/sql";
import { fromStoredPermissions, toStoredPermissions } from "../role-map.js";
import { type AnyModelMap, MAPPING } from "./mapping.js";
import { FILLED_DATES, sqliteIsoText } from "./migration.js";
import { type BetterAuthTable, type Names, TABLE_FIELDS } from "./names.js";
import {
  hasTempForm,
  isPlaceholder,
  type PlaceholderRule,
  placeholderFor,
  placeholderSql,
} from "./placeholder.js";

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
  "authtempo compat: a credential account row has no password; it reads as no password row";
const PG_KEY_RE = /^Key \((.+?)\)=\(/;
const SQLITE_UNIQUE_RE = /UNIQUE constraint failed: ((?:[\w"]+\.[\w"]+)(?:, [\w"]+\.[\w"]+)*)/;

export interface CompatStatements extends SqlStatements {
  toStorageError(model: ModelName, err: unknown): StorageError | null;
}

/**
 * The core models with no table in this storage. A read answers empty, as
 * for a where that never matches. A create throws `unknown_model`, so a
 * write never vanishes in silence. Plan 8b put `apiToken` here on
 * 2026-10-11, and plan 12k Task 1 its four models. Tasks 10 and 11 map
 * three of them onto Better Auth tables. Task 12 gives `apiToken` and
 * `organizationToken` core's own tables (`CORE_TABLE_MODELS`). So the set
 * is empty, and it stays for the next model that a core plan adds first.
 */
export const UNMAPPED_MODELS: ReadonlySet<ModelName> = new Set<ModelName>([]);

/** `reinsertRows` of `st`, else `reinsertRow` per row. */
function reinsertEach(st: SqlStatements, model: ModelName, rows: readonly Row[]): Statement[] {
  return st.reinsertRows ? st.reinsertRows(model, rows) : rows.map((r) => st.reinsertRow(model, r));
}

/** `restoreRows` of `st`, else `restoreRow` per row. */
function restoreEach<M extends ModelName>(
  st: SqlStatements,
  model: M,
  rows: readonly Row[],
  data: Partial<Omit<Models[M], "id">>,
): Statement[] {
  return st.restoreRows
    ? st.restoreRows(model, rows, data)
    : rows.map((r) => st.restoreRow(model, r, data));
}

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
    insertMany(model, rows) {
      return none(model) ? refuse(model) : st.insertMany(model, rows);
    },
    insertParams(model) {
      return none(model) ? refuse(model) : st.insertParams(model);
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
    reinsertRows(model, rows) {
      return none(model) ? refuse(model) : reinsertEach(st, model, rows);
    },
    restoreRows(model, rows, data) {
      return none(model) ? refuse(model) : restoreEach(st, model, rows, data);
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
  // Plan 12c: migration 0005 creates it and copies the enabled ta_totp rows.
  // The Better Auth twoFactor table stays unread, as for totp.
  "secondFactor",
  // Plan 12e: migration 0008 creates them. The Better Auth tables of its
  // OAuth plugins and its device plugin are neither read nor written.
  "oauthDevice",
  "oauthSubject",
  "oauthSessionClient",
  "oauthLogout",
  // Plan 12f: migration 0009 creates it. The Better Auth admin plugin keeps
  // no audit table, so no Better Auth table is read or written.
  "operatorAudit",
  // Plan 12k Task 12: migration 0010 creates both (owner decision 4). The
  // Better Auth apikey table is read only by moveBetterAuthApiKeys.
  "apiToken",
  "organizationToken",
  // The record of each moved apikey row (review finding M2): migration 0010 creates it.
  "movedToken",
  // Plan 12d: core's own tables beside the Better Auth tables; Better Auth's
  // ssoProvider and SCIM tables stay in place, and copyBetterAuthSso copies
  // their rows (Task 14). Migration 0011 creates the six.
  "ssoConnection",
  "ssoDomain",
  "scimToken",
  "scimUser",
  "scimGroup",
  "scimGroupMember",
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
    insertMany(model, rows) {
      return own(model) ? core.insertMany(model, rows) : st.insertMany(model, rows);
    },
    insertParams(model) {
      return own(model) ? core.insertParams(model) : st.insertParams(model);
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
    reinsertRows(model, rows) {
      return reinsertEach(own(model) ? core : st, model, rows);
    },
    restoreRows(model, rows, data) {
      return restoreEach(own(model) ? core : st, model, rows, data);
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
export function compatStatements(
  dialect: "postgres" | "sqlite",
  names: Names,
  // The placeholder domain of the anonymous plugin (plan 12i Task 16), read at each statement.
  rule: PlaceholderRule = { domain: null },
): CompatStatements {
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
    const t = MAP[model].table;
    // A Better Auth placeholder address reads as no address (plan 12i Task 16).
    if (MAP[model].fields[field]?.codec === "placeholder")
      return `CASE WHEN ${placeholderSql(c, rule.domain, column(model, "id"))} THEN NULL ELSE ${c} END`;
    // A column that reads as null unless its gate column is true (ruling 15 of plan 12i).
    const when = MAP[model].fields[field]?.onlyWhen;
    if (when) return `CASE WHEN ${names.column(t, when)} THEN ${c} END`;
    // A nullable Better Auth column that core reads as another while it is null (plan 12k).
    const or = MAP[model].fields[field]?.orColumn;
    if (or) {
      const from = names.column(t, or);
      return `COALESCE(${c}, ${pg ? `date_trunc('milliseconds', ${from})` : sqliteIsoText(from)})`;
    }
    if (pg) return c;
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
  /**
   * The bound value of an extra column. A text that bypasses encode stores
   * U+FFFD for a lone surrogate too (ruling 85). A boolean binds as 0 or 1
   * on SQLite, as encodeValue writes it (ruling 15 of plan 12i).
   */
  const extra = (v: unknown): unknown =>
    typeof v === "string" ? wellFormed(v) : typeof v === "boolean" && !pg ? (v ? 1 : 0) : v;

  function encode(model: ModelName, field: string, value: unknown): unknown {
    const { type } = def(model, field);
    const codec = MAP[model].fields[field]?.codec;
    if (codec === "placeholder") {
      // insertRows writes the placeholder of the row's id for a null. Core
      // never clears an address by an update, so a null here has no id.
      if (value === null || value === undefined)
        throw invalid(model, field, "the Better Auth table needs a value here");
      // It would read back as no address: a person's own address never takes this form.
      // The temp- form needs the row id: insertRows and update check it (ownPlaceholder).
      if (typeof value === "string" && isPlaceholder(value, rule.domain, null))
        throw invalid(model, field, "an address on a placeholder domain reads back as no address");
    }
    const given =
      codec === "nullAsEmpty" && (value === null || value === undefined)
        ? ""
        : codec === "permission"
          ? toStoredPermissions(value)
          : value;
    // core's encodeValue checks the type and refuses NUL; it answers JSON text and SQLite 0 or 1.
    const v = encodeValue(d, type, given, model, field);
    if (v === null) return null;
    if (codec === "commaList") {
      // Each entry is an id: a "," in one would split it into two at the read.
      if (!Array.isArray(given) || given.some((x) => typeof x !== "string" || x.includes(",")))
        throw invalid(model, field, "expected a list of ids with no comma");
      return given.length === 0 ? null : given.join(",");
    }
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
      } else if (codec === "commaList") {
        // Better Auth's comma-joined ids (invitation.teamId). An empty text is no list.
        if (typeof v !== "string") throw new StorageError("schema_mismatch", model, [field]);
        v = v === "" ? null : v.split(",");
      } else if (codec === "permission") {
        // Better Auth's JSON text. A text that does not parse reads as the
        // text, and core's shape rule refuses the row (spec 29 item 6, rule 7).
        let parsed: unknown = v;
        if (typeof v === "string")
          try {
            parsed = JSON.parse(v);
          } catch {
            parsed = v;
          }
        v = fromStoredPermissions(parsed);
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

  /**
   * Throws when a write gives a row its own placeholder, `temp-<id>@<domain>`
   * (ruling 42 M1): it would read back as no address. `ids` holds the ids
   * of the rows that the write reaches, or null when the where names none.
   * With no ids, a value in the temp- form is refused: no row can be cleared.
   */
  function ownPlaceholder(model: ModelName, data: Row, ids: readonly unknown[] | null): void {
    for (const [field, value] of Object.entries(data)) {
      if (MAP[model].fields[field]?.codec !== "placeholder" || typeof value !== "string") continue;
      if (!hasTempForm(value, rule.domain)) continue;
      if (ids === null || ids.some((id) => isPlaceholder(value, rule.domain, String(id))))
        throw invalid(model, field, "the temp- address of the row itself reads back as no address");
    }
  }

  /** The ids that an eq or an in of `id` names, or null when no clause names them. */
  function idsOf(where: readonly Where<ModelName>[]): unknown[] | null {
    const w = where.find((x) => x.field === "id" && (x.op === "eq" || x.op === "in"));
    if (!w) return null;
    return Array.isArray(w.value) ? w.value : [w.value];
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
      // One text rule with core's builder: a NUL or a lone surrogate throws (ruling 17 of plan 12g).
      assertWhereText(model, w.field, w.value);
      const enc = (v: unknown) => p.add(encode(model, w.field, v), type);
      // A placeholder address reads as null (plan 12i Task 16). An eq or an
      // in of an address compares the raw column, so the unique index
      // serves the lookup. A value that is no placeholder equals the raw
      // column exactly where it equals the read. A value on a placeholder
      // domain matches no row, because every row of one reads null. A value
      // in the temp- form is a placeholder only on the row of its id, so
      // that row is left out (ruling 42 M1).
      const held = codec === "placeholder";
      const real = (v: unknown) => !(typeof v === "string" && isPlaceholder(v, rule.domain, null));
      const raw = held ? column(model, w.field) : c;
      const notOwn = (vs: unknown[]) =>
        held && vs.some((v) => typeof v === "string" && hasTempForm(v, rule.domain))
          ? [`NOT ${placeholderSql(raw, rule.domain, column(model, "id"))}`]
          : [];
      switch (w.op) {
        case "eq":
          if (!isNull(w.value) && !real(w.value)) {
            impossible = true;
            break;
          }
          parts.push(
            isNull(w.value) ? (empty ? `${c} = ''` : `${c} IS NULL`) : `${raw} = ${enc(w.value)}`,
          );
          if (!isNull(w.value)) parts.push(...notOwn([w.value]));
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
          const vals = w.value.filter((v) => !isNull(v) && real(v));
          for (const v of vals) encode(model, w.field, v);
          if (vals.length === 0) {
            impossible = true;
            break;
          }
          // A long list binds one JSON text on SQLite, as in core's builder (ruling 84 of
          // plan 12d). The values stay bound, and none enters the SQL text.
          if (!pg && vals.length > IN_PARAMS_MAX)
            parts.push(
              `${raw} IN (SELECT value FROM json_each(${p.add(JSON.stringify(vals.map((v) => encode(model, w.field, v))))}))`,
            );
          else parts.push(`${raw} IN (${vals.map(enc).join(", ")})`);
          parts.push(...notOwn(vals));
          break;
        }
        case "startsWith":
          if (type !== "string" || typeof w.value !== "string" || w.value === "")
            throw invalid(model, w.field, "startsWith takes a non-empty string on a string field");
          // substr, not LIKE, as in core's builder (plan 12f deviation 2): exact, with case,
          // and no wildcard. The count is code points, as substr counts on both dialects.
          // A nullAsEmpty field needs no "<> ''" clause: the prefix is never empty.
          parts.push(`substr(${c}, 1, ${p.add([...w.value].length)}) = ${enc(w.value)}`);
          break;
        default: {
          // The four range ops only: lt, lte, gt, and gte.
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
    // Better Auth's unique membershipKey names the pair (mapping.ts teamMembershipKey).
    if (t === "teamMember" && baFields.length === 1 && baFields[0] === "membershipKey")
      return ["teamId", "userId"];
    const entries = Object.entries(MAP[model].fields);
    return baFields
      .map((f) => entries.find(([, m]) => m.column === f)?.[0])
      .filter((f): f is string => f !== undefined);
  }

  /** One INSERT of each row: the columns of the first row, a VALUES tuple per row. */
  function insertRows(model: ModelName, rows: readonly Row[]): { sql: string; params: unknown[] } {
    assertModel(model);
    const map = MAP[model];
    const p = new Params();
    let cols: string[] = [];
    const tuples = rows.map((data) => {
      assertFields(model, Object.keys(data));
      ownPlaceholder(model, data, [data.id]);
      const own: string[] = [];
      const vals: string[] = [];
      for (const field of Object.keys(map.fields)) {
        own.push(column(model, field));
        // A core null address is Better Auth's placeholder of the row (plan 12i Task 16).
        const v =
          map.fields[field]?.codec === "placeholder" && data[field] === null
            ? encodeValue(d, "string", placeholderFor(String(data.id), rule.domain), model, field)
            : encode(model, field, data[field]);
        vals.push(p.add(v, def(model, field).type));
      }
      for (const [c, v] of Object.entries(map.insertExtras?.(data) ?? {})) {
        own.push(names.column(map.table, c));
        vals.push(p.add(extra(v)));
      }
      // insertExtras names the same columns for every row of a model. A row with other
      // columns would shift its values into the wrong columns of the JSON form, so it throws.
      if (cols.length === 0) cols = own;
      else if (own.length !== cols.length || own.some((c, i) => c !== cols[i]))
        throw invalid(model, "rows", "each row of an insert names the same columns");
      return `(${vals.join(", ")})`;
    });
    if (tuples.length === 0) throw invalid(model, "rows", "an insert needs at least one row");
    // More than one row on SQLite: the values bind as one JSON list of tuples, in the order
    // of the placeholders (ruling 84 of plan 12d). One row keeps the statement it had.
    if (!pg && rows.length > 1) {
      const width = cols.length;
      const list = Array.from({ length: rows.length }, (_, r) =>
        p.values.slice(r * width, (r + 1) * width),
      );
      return {
        sql: `INSERT INTO ${table(model)} (${cols.join(", ")}) ${jsonRows(width)}`,
        params: [JSON.stringify(list)],
      };
    }
    return {
      sql: `INSERT INTO ${table(model)} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`,
      params: p.values,
    };
  }

  /**
   * The columns that the undo of an update writes back, for `restoreRow`
   * and `restoreRows`. The row comes from SELECT *, so its keys are the
   * DDL's spelling. On SQLite that can differ in case from the configured
   * names. Core's rule (`SqlStatements.restoreRow`): only the columns the
   * update set. These are the column of each field of `data` and each
   * `updateExtras` column. So a claim's change to another column stays
   * (final review M-1). Each column goes back on its own, and only while
   * it holds the value the update wrote. So a later write of another
   * request stays (ruling 46 of plan 12k), and the other columns still go
   * back (ruling 47).
   */
  function restoreColumns(
    model: ModelName,
    row: Row,
    data: Row,
  ): { idKey: string; cols: string[]; written: unknown[] } {
    const map = MAP[model];
    const t = map.table;
    const idKey =
      Object.keys(row).find((c) => fieldOfRaw(t, c) === "id") ?? names.rawColumn(t, "id");
    const extras = map.updateExtras?.(data) ?? {};
    const set = [
      ...Object.keys(data).map((f) => map.fields[f]?.column ?? f),
      ...Object.keys(extras),
    ];
    const written = [
      ...Object.keys(data).map((f) => encode(model, f, data[f])),
      ...Object.values(extras).map(extra),
    ];
    const cols = set.map((f) => {
      const c = Object.keys(row).find((k) => k !== idKey && fieldOfRaw(t, k) === f);
      // The update wrote this column, so the SELECT * before it read it.
      if (c === undefined) throw new StorageError("schema_mismatch", model, [f]);
      return c;
    });
    return { idKey, cols, written };
  }

  const st: CompatStatements = {
    insert(model, data) {
      return insertRows(model, [data as unknown as Row]);
    },
    insertMany(model, rows) {
      return insertRows(model, rows as unknown as readonly Row[]);
    },
    insertParams(model) {
      assertModel(model);
      // SQLite binds the rows of insertMany as one JSON list (ruling 84 of plan 12d).
      if (!pg) return 0;
      const map = MAP[model];
      // The extras of a row of empty text: the keys are the same for every row.
      const blank = Object.fromEntries(Object.keys(map.fields).map((f) => [f, ""]));
      return Object.keys(map.fields).length + Object.keys(map.insertExtras?.(blank) ?? {}).length;
    },
    select(model, where, opts = {}) {
      assertModel(model);
      const sorts = sortsOf(model, opts);
      if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0)) {
        throw invalid(model, "limit", "expected a non-negative integer");
      }
      const p = new Params();
      const w = compileWhere(model, where as Where<ModelName>[], p);
      if (w.impossible) return null;
      const list = Object.keys(MAP[model].fields)
        .map(
          (f) =>
            `${pg && def(model, f).type === "date" ? pgDate(value(model, f)) : value(model, f)} AS "${f}"`,
        )
        .join(", ");
      let sql = `SELECT ${list} FROM ${table(model)}${w.clause}`;
      if (sorts.length > 0) {
        const terms = sorts.map((s) => {
          // Qualified, so Postgres sorts by the column and not by the output alias of the same name.
          // A gated read and a placeholder read name more than their alias, so they sort by the read value.
          const field = MAP[model].fields[s.field];
          const raw =
            pg && !field?.onlyWhen && field?.codec !== "placeholder"
              ? qualified(model, s.field)
              : value(model, s.field);
          const e =
            MAP[model].fields[s.field]?.codec === "nullAsEmpty" ? `NULLIF(${raw}, '')` : raw;
          const dir = s.dir === "asc" ? "ASC" : "DESC";
          // A notNull key names a column that holds no null, so an index gives the order.
          return pg || s.notNull
            ? `${e} ${dir}`
            : `${e} IS NULL${dir === "DESC" ? " DESC" : ""}, ${e} ${dir}`;
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
      ownPlaceholder(model, data as Row, idsOf(where as Where<ModelName>[]));
      const map = MAP[model];
      const p = new Params();
      const sets = keys.map(
        (f) =>
          `${column(model, f)} = ${p.add(encode(model, f, (data as Row)[f]), def(model, f).type)}`,
      );
      for (const [c, v] of Object.entries(map.updateExtras?.(data as Row) ?? {}))
        sets.push(`${names.column(map.table, c)} = ${p.add(extra(v))}`);
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
      const { idKey, cols, written } = restoreColumns(model, row, data as Row);
      const p = new Params();
      const eq = d.nullSafeEq;
      const sets = cols.map((c, i) => {
        const q = quoteRaw(c);
        return `${q} = CASE WHEN ${q} ${eq} ${p.add(written[i])} THEN ${p.add(row[c])} ELSE ${q} END`;
      });
      return {
        sql: `UPDATE ${table(model)} SET ${sets.join(", ")} WHERE ${column(model, "id")} = ${p.add(row[idKey])}`,
        params: p.values,
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
    reinsertRows(model, rows) {
      const first = rows[0];
      if (pg || first === undefined || !jsonSafeRows(rows))
        return rows.map((r) => st.reinsertRow(model, r));
      const cols = Object.keys(first);
      return listChunks(rows.map((r) => cols.map((c) => r[c]))).map((chunk) => ({
        sql: `INSERT INTO ${table(model)} (${cols.map(quoteRaw).join(", ")}) ${jsonRows(cols.length)}`,
        params: [JSON.stringify(chunk)],
      }));
    },
    restoreRows(model, rows, data) {
      const first = rows[0];
      if (pg || first === undefined || rows.length < 2 || !jsonSafeRows(rows))
        return rows.map((r) => st.restoreRow(model, r, data));
      // The rule of restoreRow, with the old values of each row from one JSON list that
      // joins the table by id (ruling 84 of plan 12d). The rows of SELECT * share their keys.
      const { idKey, cols, written } = restoreColumns(model, first, data as Row);
      const target = table(model);
      const p = new Params();
      const sets = cols.map((c, i) => {
        const q = quoteRaw(c);
        return `${q} = CASE WHEN ${target}.${q} ${d.nullSafeEq} ${p.add(written[i])} THEN u.c${i + 1} ELSE ${target}.${q} END`;
      });
      const keys = [idKey, ...cols];
      const pick = keys.map((_, i) => `json_extract(value, '$[${i}]') AS c${i}`);
      return listChunks(rows.map((r) => keys.map((c) => r[c]))).map((chunk) => {
        const q = new Params();
        q.values.push(...p.values);
        const list = q.add(JSON.stringify(chunk));
        return {
          sql: `UPDATE ${target} SET ${sets.join(", ")} FROM (SELECT ${pick.join(", ")} FROM json_each(${list})) AS u WHERE ${target}.${column(model, "id")} = u.c0`,
          params: q.values,
        };
      });
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
