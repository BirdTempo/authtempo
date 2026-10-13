import { env } from "cloudflare:test";
import { type ModelName, schema } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnName, columnsOf, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

async function truncateAll(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

runAdapterConformance("d1", async () => {
  await truncateAll();
  return { adapter: createD1Adapter(env.DB), close: truncateAll };
});

interface IndexShape {
  name: string;
  unique: boolean;
  columns: string[];
}

/** The indexes that `schema` asks for, by the names core gives them. */
function expectedIndexes(model: ModelName): IndexShape[] {
  const table = TABLES[model];
  const cols = (fields: readonly string[]) => fields.map(columnName);
  return [
    ...schema[model].unique.map((f) => ({
      name: uniqueIndexName(model, f),
      unique: true,
      columns: cols(f),
    })),
    ...schema[model].indexes.map((f) => ({
      name: `ix_${table}__${cols(f).join("__")}`,
      unique: false,
      columns: cols(f),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** The indexes the migration made with CREATE INDEX (origin "c"), not the primary key. */
async function actualIndexes(table: string): Promise<IndexShape[]> {
  const list = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{
    name: string;
    unique: number;
    origin: string;
  }>();
  const out: IndexShape[] = [];
  for (const ix of list.results.filter((i) => i.origin === "c")) {
    const info = await env.DB.prepare(`PRAGMA index_info(${ix.name})`).all<{
      seqno: number;
      name: string;
    }>();
    const columns = [...info.results].sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    out.push({ name: ix.name, unique: ix.unique === 1, columns });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe("d1 migration matches the core schema", () => {
  it("has every table with the columns core expects, in order", async () => {
    for (const [model, table] of Object.entries(TABLES)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(info.results.map((c) => c.name)).toEqual(columnsOf(model as ModelName));
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

  it("marks NOT NULL exactly on the fields that schema does not mark nullable", async () => {
    for (const model of Object.keys(schema) as ModelName[]) {
      const info = await env.DB.prepare(`PRAGMA table_info(${TABLES[model]})`).all<{
        name: string;
        notnull: number;
      }>();
      const actual = Object.fromEntries(info.results.map((c) => [c.name, c.notnull]));
      const fields = schema[model].fields as Record<string, { nullable?: boolean }>;
      const expected = Object.fromEntries(
        Object.entries(fields).map(([f, def]) => [columnName(f), def.nullable ? 0 : 1]),
      );
      expect({ model, notnull: actual }).toEqual({ model, notnull: expected });
    }
    const meta = await env.DB.prepare("PRAGMA table_info(ta_meta)").all<{
      name: string;
      notnull: number;
    }>();
    expect(meta.results.map((c) => [c.name, c.notnull])).toEqual([
      ["key", 1],
      ["value", 1],
    ]);
  });

  it("has every unique index and index that schema lists, with core's names and column order", async () => {
    for (const model of Object.keys(schema) as ModelName[]) {
      expect({ model, indexes: await actualIndexes(TABLES[model]) }).toEqual({
        model,
        indexes: expectedIndexes(model),
      });
    }
  });
});
