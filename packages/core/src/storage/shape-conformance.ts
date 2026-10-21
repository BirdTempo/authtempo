import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import { RUNNER_TABLES, schemaDdl } from "./ddl.js";
import type { Dialect, ExpectedShape, ExpectedTable, LiveShape, ShapeIndex } from "./sql.js";

/** One database read back: its live shape and the `schema_version` row of `ta_meta`, or null with no row. */
export interface ShapeSide {
  shape: LiveShape;
  version: string | null;
}

/**
 * One engine under the shape check (plan 12g). `shipped` builds a new
 * database with the adapter's own migration list and reads it back. The
 * list runs through the runner, or on a fixture through its steps without
 * the lock. `fromDdl` applies the
 * statements to a new empty database and reads it back. `close` drops what
 * the two calls made. `dialect` gives the DDL text that `fromDdl` gets.
 */
export interface ShapeTarget {
  dialect: Dialect;
  expected: ExpectedShape;
  shipped(): Promise<ShapeSide>;
  fromDdl(statements: readonly string[]): Promise<ShapeSide>;
  close(): Promise<void>;
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The live shape with no `hasDefault`, with the tables sorted by name. The
 * engine writes every field on each insert, so a column default never
 * decides a stored value (deviation 2 of plan 12g). The order of creation
 * does not count.
 */
export function withoutDefaults(shape: LiveShape): ExpectedShape {
  return shape
    .map(
      (t): ExpectedTable => ({
        ...t,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull })),
      }),
    )
    .sort(byName);
}

const keyText = (ix: ShapeIndex) => `${ix.name} (${ix.columns.join(", ")})`;

/**
 * Each difference between two shapes, in both directions, by table and
 * column. `a` and `b` name the two sides in the text. The CLI's
 * `compareShape` cannot serve here: the CLI imports core, and it reads one
 * side as the expected side only.
 */
export function shapeDifferences(
  left: ExpectedShape,
  right: ExpectedShape,
  a: string,
  b: string,
): string[] {
  const out: string[] = [];
  const rightTables = new Map(right.map((t) => [t.name, t]));
  for (const l of left) {
    const r = rightTables.get(l.name);
    if (!r) {
      out.push(`${l.name}: only in ${a}`);
      continue;
    }
    const rightColumns = new Map(r.columns.map((c) => [c.name, c]));
    for (const c of l.columns) {
      const rc = rightColumns.get(c.name);
      if (!rc) out.push(`${l.name}.${c.name}: only in ${a}`);
      else if (rc.type !== c.type || rc.notNull !== c.notNull)
        out.push(
          `${l.name}.${c.name}: ${c.type}${c.notNull ? " NOT NULL" : ""} in ${a}, ${rc.type}${rc.notNull ? " NOT NULL" : ""} in ${b}`,
        );
    }
    const leftColumns = new Set(l.columns.map((c) => c.name));
    for (const c of r.columns)
      if (!leftColumns.has(c.name)) out.push(`${l.name}.${c.name}: only in ${b}`);
    const order = (t: ExpectedTable) => t.columns.map((c) => c.name).join(", ");
    const sameNames =
      l.columns.length === r.columns.length && l.columns.every((c) => rightColumns.has(c.name));
    if (sameNames && order(l) !== order(r))
      out.push(`${l.name}: the column order is ${order(l)} in ${a}, ${order(r)} in ${b}`);
    if (l.primaryKey.join(", ") !== r.primaryKey.join(", "))
      out.push(
        `${l.name}: the primary key is (${l.primaryKey.join(", ")}) in ${a}, (${r.primaryKey.join(", ")}) in ${b}`,
      );
    for (const kind of ["unique", "indexes"] as const) {
      const leftKeys = new Set(l[kind].map(keyText));
      const rightKeys = new Set(r[kind].map(keyText));
      for (const k of leftKeys)
        if (!rightKeys.has(k)) out.push(`${l.name} ${kind} ${k}: only in ${a}`);
      for (const k of rightKeys)
        if (!leftKeys.has(k)) out.push(`${l.name} ${kind} ${k}: only in ${b}`);
    }
  }
  const leftTables = new Set(left.map((t) => t.name));
  for (const r of right) if (!leftTables.has(r.name)) out.push(`${r.name}: only in ${b}`);
  return out;
}

/**
 * The shape check of one engine (plan 12g, spec section 28 item 5). The
 * database that the shipped migrations build equals the database that
 * `schemaDdl` builds, the runner tables and the column defaults aside. It
 * also equals the adapter's expected shape. Both sides record
 * `SCHEMA_VERSION`. A field added to the schema with no migration fails the
 * first test with its table and column.
 */
export function runShapeConformance(name: string, factory: () => Promise<ShapeTarget>): void {
  describe(`shape conformance: ${name}`, () => {
    async function withTarget(run: (t: ShapeTarget) => Promise<void>): Promise<void> {
      const target = await factory();
      try {
        await run(target);
      } finally {
        await target.close();
      }
    }

    it("builds the database that schemaDdl builds", async () => {
      await withTarget(async (t) => {
        const shipped = withoutDefaults((await t.shipped()).shape).filter(
          (table) => !RUNNER_TABLES.includes(table.name),
        );
        const ddl = withoutDefaults((await t.fromDdl(schemaDdl(t.dialect))).shape);
        expect(shapeDifferences(shipped, ddl, "the shipped migrations", "schemaDdl")).toEqual([]);
        expect(shipped).toEqual(ddl);
      });
    });

    it("builds the shape that the adapter expects", async () => {
      await withTarget(async (t) => {
        const shipped = withoutDefaults((await t.shipped()).shape);
        expect(
          shapeDifferences(shipped, t.expected, "the shipped migrations", "the expected shape"),
        ).toEqual([]);
        expect(shipped).toEqual(t.expected);
      });
    });

    it("records the schema version", async () => {
      await withTarget(async (t) => {
        const shipped = await t.shipped();
        const ddl = await t.fromDdl(schemaDdl(t.dialect));
        expect({ shipped: shipped.version, ddl: ddl.version }).toEqual({
          shipped: String(SCHEMA_VERSION),
          ddl: String(SCHEMA_VERSION),
        });
      });
    });
  });
}
