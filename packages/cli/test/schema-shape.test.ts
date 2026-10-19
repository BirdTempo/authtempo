import { expectedPostgresShape } from "@authtempo/adapter-postgres";
import type { ExpectedTable, LiveShape, LiveTable } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { compareShape, findingText, PLAIN_NAME } from "../src/schema-shape.js";

// compareShape with no database (plan 11c2 Task 7). Each live shape is the
// expected shape with one change that an operator's ALTER or DROP makes.

const EXPECTED = expectedPostgresShape();

/**
 * The live form of a table. Four secret_version columns have DEFAULT 1
 * (migration 0009), but compareShape reads hasDefault of an extra column
 * only, so false serves for each column of core.
 */
const liveTable = (t: ExpectedTable): LiveTable => ({
  ...t,
  columns: t.columns.map((c) => ({ ...c, hasDefault: false })),
});

/** The fresh live shape, with `change` applied to the table `name`. */
function liveWith(name: string, change: (t: LiveTable) => LiveTable | null): LiveShape {
  return EXPECTED.flatMap((t) => {
    const live = liveTable(t);
    if (t.name !== name) return [live];
    const changed = change(live);
    return changed === null ? [] : [changed];
  });
}

const fresh = (): LiveShape => EXPECTED.map(liveTable);

describe("compareShape (plan 11c2)", () => {
  it("finds no difference on the expected shape", () => {
    expect(compareShape(EXPECTED, fresh())).toEqual([]);
  });

  it("fails each missing table, column, type, NOT NULL bit, and unique index with its code", () => {
    // DROP TABLE ta_session
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_session", () => null),
      ),
    ).toEqual([{ code: "schema_table_missing", kind: "fail", table: "ta_session" }]);
    // ALTER TABLE ta_user DROP COLUMN email: Postgres drops its unique index too.
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({
          ...t,
          columns: t.columns.filter((c) => c.name !== "email"),
          unique: [],
        })),
      ),
    ).toEqual([
      { code: "schema_column_missing", kind: "fail", table: "ta_user", column: "email" },
      { code: "schema_unique_missing", kind: "fail", table: "ta_user", index: "ux_ta_user__email" },
    ]);
    // ALTER TABLE ta_session ALTER COLUMN expires_at TYPE text
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_session", (t) => ({
          ...t,
          columns: t.columns.map((c) => (c.name === "expires_at" ? { ...c, type: "text" } : c)),
        })),
      ),
    ).toEqual([
      { code: "schema_column_type", kind: "fail", table: "ta_session", column: "expires_at" },
    ]);
    // ALTER TABLE ta_user ALTER COLUMN name SET NOT NULL
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({
          ...t,
          columns: t.columns.map((c) => (c.name === "name" ? { ...c, notNull: true } : c)),
        })),
      ),
    ).toEqual([{ code: "schema_column_null", kind: "fail", table: "ta_user", column: "name" }]);
    // DROP INDEX ux_ta_user__email
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({ ...t, unique: [] })),
      ),
    ).toEqual([
      { code: "schema_unique_missing", kind: "fail", table: "ta_user", index: "ux_ta_user__email" },
    ]);
    // The unique index made again with the other column order.
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_member", (t) => ({
          ...t,
          unique: [
            {
              name: "ux_ta_member__organization_id__user_id",
              columns: ["user_id", "organization_id"],
            },
          ],
        })),
      ),
    ).toEqual([
      {
        code: "schema_unique_missing",
        kind: "fail",
        table: "ta_member",
        index: "ux_ta_member__organization_id__user_id",
      },
    ]);
    // ALTER TABLE ta_user DROP CONSTRAINT ta_user_pkey: a finding with no index name.
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({ ...t, primaryKey: [] })),
      ),
    ).toEqual([{ code: "schema_unique_missing", kind: "fail", table: "ta_user" }]);
    // The type compare ignores case: D1 and an operator can write a type in either case.
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({
          ...t,
          columns: t.columns.map((c) => (c.name === "email" ? { ...c, type: "TEXT" } : c)),
        })),
      ),
    ).toEqual([]);
  });

  it("warns on a missing plain index, an extra column, an extra required column, and an extra ta_ table", () => {
    // DROP INDEX ix_ta_session__user_id
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_session", (t) => ({
          ...t,
          indexes: t.indexes.filter((i) => i.name !== "ix_ta_session__user_id"),
        })),
      ),
    ).toEqual([
      {
        code: "schema_index_missing",
        kind: "warn",
        table: "ta_session",
        index: "ix_ta_session__user_id",
      },
    ]);
    // ADD COLUMN nickname text; ADD COLUMN plan text NOT NULL; ADD COLUMN tier text NOT NULL DEFAULT 'x'
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({
          ...t,
          columns: [
            ...t.columns,
            { name: "nickname", type: "text", notNull: false, hasDefault: false },
            { name: "plan", type: "text", notNull: true, hasDefault: false },
            { name: "tier", type: "text", notNull: true, hasDefault: true },
          ],
        })),
      ),
    ).toEqual([
      { code: "schema_column_extra", kind: "warn", table: "ta_user", column: "nickname" },
      { code: "schema_column_extra_required", kind: "warn", table: "ta_user", column: "plan" },
      { code: "schema_column_extra", kind: "warn", table: "ta_user", column: "tier" },
    ]);
    // CREATE TABLE ta_app_note (id text PRIMARY KEY)
    const note: LiveTable = {
      name: "ta_app_note",
      columns: [{ name: "id", type: "text", notNull: true, hasDefault: false }],
      primaryKey: ["id"],
      unique: [],
      indexes: [],
    };
    expect(compareShape(EXPECTED, [...fresh(), note])).toEqual([
      { code: "schema_table_extra", kind: "warn", table: "ta_app_note" },
    ]);
    // A table of the app with no ta_ prefix is no finding.
    expect(compareShape(EXPECTED, [...fresh(), { ...note, name: "app_note" }])).toEqual([]);
  });

  it("finds nothing for another column order or an extra index", () => {
    expect(
      compareShape(
        EXPECTED,
        liveWith("ta_user", (t) => ({
          ...t,
          columns: [...t.columns].reverse(),
          indexes: [{ name: "ix_app_user_name", columns: ["name"] }],
          unique: [...t.unique, { name: "ux_app_user_image", columns: ["image"] }],
        })),
      ),
    ).toEqual([]);
  });

  it("prints no name that is not a plain SQL name", () => {
    const odd = [
      "ta_x\u001b[2J",
      "NickName",
      `ta_${"a".repeat(61)}`,
      "ta_note; DROP TABLE ta_user",
      "1ta",
    ];
    for (const name of odd) {
      expect(PLAIN_NAME.test(name), name).toBe(false);
      const texts = [
        findingText({ code: "schema_table_extra", kind: "warn", table: name }),
        findingText({ code: "schema_column_extra", kind: "warn", table: "ta_user", column: name }),
        findingText({ code: "schema_index_missing", kind: "warn", table: name, index: name }),
      ];
      for (const text of texts) {
        expect(text).not.toContain(name);
        expect(text).toContain("a name that is not a plain SQL name");
      }
    }
    // A plain name of 63 characters, the Postgres limit, prints as it is.
    const longest = `ta_${"a".repeat(60)}`;
    expect(findingText({ code: "schema_table_extra", kind: "warn", table: longest })).toBe(
      `the database has the table ${longest}, which the migrations do not make`,
    );
  });
});
