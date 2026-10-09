import { runAdapterConformance } from "@tempo-auth/core/conformance";
import { columnsOf, TABLES } from "@tempo-auth/core/sql";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

runAdapterConformance("postgres", async () => {
  const db = await freshDatabase();
  return { adapter: createPostgresAdapter(db.sql), close: () => db.close() };
});

describe("postgres migration matches the core schema", () => {
  it("has every table with the columns core expects, in order", async () => {
    const db = await freshDatabase();
    try {
      for (const [model, table] of Object.entries(TABLES)) {
        const cols = await db.sql.unsafe<{ column_name: string }[]>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
          [table],
        );
        expect(cols.map((c) => c.column_name)).toEqual(columnsOf(model as keyof typeof TABLES));
      }
    } finally {
      await db.close();
    }
  });
  it("applies migrations once", async () => {
    const db = await freshDatabase();
    try {
      const { applyPostgresMigrations } = await import("../src/migrations.js");
      expect(await applyPostgresMigrations(db.sql)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
