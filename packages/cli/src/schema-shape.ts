import type { ExpectedShape, LiveShape, ShapeIndex } from "@authtempo/core/sql";

// The table shape of `authtempo check` (plan 11c2 Task 7). This file imports
// types only and no Node.js module, so a Worker test runs it in workerd.

/**
 * A name that prints as it is: lower case, digits, and underscores, at most
 * 63 characters (the Postgres limit). A live name comes from the database,
 * so any other name prints as a fixed text.
 */
export const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** One difference between the expected shape and the live shape. */
export interface ShapeFinding {
  code: string;
  kind: "fail" | "warn";
  table: string;
  column?: string;
  /** The index name. A unique finding with no index is the primary key. */
  index?: string;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** An index of `want` is present when `live` has an index of the same name with the same columns in order. */
const hasIndex = (live: readonly ShapeIndex[], want: ShapeIndex) =>
  live.some((ix) => ix.name === want.name && sameList(ix.columns, want.columns));

/**
 * Owner decision 3 of 2026-10-14: an extra column or table warns and never
 * fails. An extra NOT NULL column with no default makes each insert of core
 * into its table fail, so it has its own warning code.
 */
export function compareShape(expected: ExpectedShape, live: LiveShape): ShapeFinding[] {
  const findings: ShapeFinding[] = [];
  const add = (
    code: string,
    kind: ShapeFinding["kind"],
    table: string,
    more: { column?: string; index?: string } = {},
  ) => {
    findings.push({ code, kind, table, ...more });
  };
  const liveTables = new Map(live.map((t) => [t.name, t]));
  for (const want of expected) {
    const have = liveTables.get(want.name);
    if (!have) {
      add("schema_table_missing", "fail", want.name);
      continue;
    }
    const columns = new Map(have.columns.map((c) => [c.name, c]));
    for (const c of want.columns) {
      const h = columns.get(c.name);
      if (!h) {
        add("schema_column_missing", "fail", want.name, { column: c.name });
        continue;
      }
      if (h.type.toLowerCase() !== c.type.toLowerCase())
        add("schema_column_type", "fail", want.name, { column: c.name });
      if (h.notNull !== c.notNull) add("schema_column_null", "fail", want.name, { column: c.name });
    }
    if (!sameList(have.primaryKey, want.primaryKey))
      add("schema_unique_missing", "fail", want.name);
    for (const u of want.unique)
      if (!hasIndex(have.unique, u))
        add("schema_unique_missing", "fail", want.name, { index: u.name });
    for (const ix of want.indexes)
      if (!hasIndex(have.indexes, ix))
        add("schema_index_missing", "warn", want.name, { index: ix.name });
    const known = new Set(want.columns.map((c) => c.name));
    for (const h of have.columns)
      if (!known.has(h.name))
        add(
          h.notNull && !h.hasDefault ? "schema_column_extra_required" : "schema_column_extra",
          "warn",
          want.name,
          { column: h.name },
        );
  }
  const names = new Set(expected.map((t) => t.name));
  for (const t of live)
    if (t.name.startsWith("ta_") && !names.has(t.name)) add("schema_table_extra", "warn", t.name);
  return findings;
}

const shown = (name: string | undefined) =>
  name !== undefined && PLAIN_NAME.test(name) ? name : "a name that is not a plain SQL name";

/** The text of a finding, with each name through `PLAIN_NAME`. */
export function findingText(f: ShapeFinding): string {
  const t = shown(f.table);
  const c = shown(f.column);
  const i = shown(f.index);
  switch (f.code) {
    case "schema_table_missing":
      return `the table ${t} is missing`;
    case "schema_column_missing":
      return `the table ${t} has no column ${c}`;
    case "schema_column_type":
      return `the column ${c} of ${t} has another type than the migrations make`;
    case "schema_column_null":
      return `the column ${c} of ${t} has another NOT NULL rule than the migrations make`;
    case "schema_unique_missing":
      return f.index === undefined
        ? `the primary key of ${t} is not the key of the migrations`
        : `the table ${t} has no unique index ${i} on the columns of the migrations`;
    case "schema_index_missing":
      return `the table ${t} has no index ${i} on the columns of the migrations`;
    case "schema_column_extra":
      return `the table ${t} has the column ${c}, which the migrations do not make`;
    case "schema_column_extra_required":
      return `the table ${t} has the NOT NULL column ${c} with no default: each insert of core into ${t} fails`;
    case "schema_table_extra":
      return `the database has the table ${t}, which the migrations do not make`;
    default:
      return `the table ${t} differs from the migrations`;
  }
}
