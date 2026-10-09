import { env } from "cloudflare:test";
import { runAdapterConformance } from "@tempo-auth/core/conformance";
import { TABLES } from "@tempo-auth/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

async function truncateAll(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

runAdapterConformance("d1", async () => {
  await truncateAll();
  return { adapter: createD1Adapter(env.DB), close: truncateAll };
});

describe("d1 migration matches the core schema", () => {
  it("has every table with the columns core expects, in order", async () => {
    const { columnsOf } = await import("@tempo-auth/core/sql");
    for (const [model, table] of Object.entries(TABLES)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(info.results.map((c) => c.name)).toEqual(columnsOf(model as keyof typeof TABLES));
    }
  });
});
