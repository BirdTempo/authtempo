import { describe, expect, it } from "vitest";
import { applyPostgresMigrations, MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

describe("postgres migration runner", () => {
  it("lets two runners start at once on one empty schema: one applies, one skips", async () => {
    const db = await freshSchema();
    try {
      const results = await Promise.allSettled([
        applyPostgresMigrations(db.a),
        applyPostgresMigrations(db.b),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const lists = results.map((r) => (r.status === "fulfilled" ? r.value : null));
      const names = MIGRATIONS.map((m) => m.name);
      expect(lists.filter((l) => l?.length === names.length)).toEqual([names]);
      expect(lists.filter((l) => l?.length === 0)).toHaveLength(1);
      const rows = await db.a.unsafe<{ name: string }[]>("SELECT name FROM ta_migrations");
      expect(rows.map((r) => r.name)).toEqual(names);
    } finally {
      await db.close();
    }
  });
});
