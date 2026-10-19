import { env } from "cloudflare:test";
import { type ModelName, schema } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnsOf, type LiveShape, TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter, D1_SHAPE_SQL, expectedD1Shape, parseD1Shape } from "../src/index.js";

async function truncateAll(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

runAdapterConformance("d1", async () => {
  await truncateAll();
  return { adapter: createD1Adapter(env.DB), close: truncateAll };
});

/** The live shape of the test database, read with the two exported SQL texts. */
async function liveShape(): Promise<LiveShape> {
  const columns = await env.DB.prepare(D1_SHAPE_SQL.columns).all();
  const indexes = await env.DB.prepare(D1_SHAPE_SQL.indexes).all();
  return parseD1Shape(columns.results, indexes.results);
}

describe("d1 migration matches the core schema", () => {
  it("the fresh database has the shape of expectedD1Shape()", async () => {
    // The expected shape holds no default, so compare the live shape without it.
    const withoutDefault = (await liveShape()).map((t) => ({
      ...t,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull })),
    }));
    expect(withoutDefault).toEqual(expectedD1Shape());
  });

  it("lists the columns of each model in the order of schema", () => {
    const shape = expectedD1Shape();
    for (const model of Object.keys(schema) as ModelName[]) {
      const table = shape.find((t) => t.name === TABLES[model]);
      expect({ model, columns: table?.columns.map((c) => c.name) }).toEqual({
        model,
        columns: columnsOf(model),
      });
    }
  });

  it("declares every unique key as a named index, never inline", async () => {
    // An inline UNIQUE makes SQLite name the index itself, so the adapter's
    // error mapping (which reads core's index names) cannot map it to fields.
    const rows = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta_%'",
    ).all<{ name: string; sql: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect({ table: row.name, inlineUnique: /\bUNIQUE\b/i.test(row.sql) }).toEqual({
        table: row.name,
        inlineUnique: false,
      });
    }
  });

  it("reads an extra column with its default", async () => {
    // The database lives for the whole file, so the test drops the column again.
    await env.DB.prepare("ALTER TABLE ta_user ADD COLUMN nickname TEXT DEFAULT 'x'").run();
    try {
      const user = (await liveShape()).find((t) => t.name === "ta_user");
      expect(user?.columns.find((c) => c.name === "nickname")).toEqual({
        name: "nickname",
        type: "TEXT",
        notNull: false,
        hasDefault: true,
      });
      expect(user?.columns.find((c) => c.name === "email")).toEqual({
        name: "email",
        type: "TEXT",
        notNull: true,
        hasDefault: false,
      });
    } finally {
      await env.DB.prepare("ALTER TABLE ta_user DROP COLUMN nickname").run();
    }
  });

  it("refuses a shape row with a field of the wrong type, and names the field", () => {
    const column = {
      tableName: "ta_user",
      name: "id",
      type: "TEXT",
      notNull: 1,
      dflt: null,
      pk: 1,
    };
    expect(parseD1Shape([column], [])).toHaveLength(1);
    expect(() => parseD1Shape([{ ...column, notNull: "1" }], [])).toThrow(/notNull/);
    const index = {
      tableName: "ta_user",
      name: "ux_ta_user__email",
      isUnique: 1,
      origin: "c",
      seqno: 0,
      col: "email",
    };
    expect(() => parseD1Shape([column], [{ ...index, seqno: "0" }])).toThrow(/seqno/);
    expect(() => parseD1Shape([column], [null])).toThrow(Error);
  });
});
