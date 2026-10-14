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

  it("copies each enabled totp row into ta_second_factor with the same id at 0008 (plan 12c)", async () => {
    const db = await freshSchema();
    try {
      // The database as version 7 left it, with the runner's own record, so
      // the runner applies 0008 alone.
      await db.a.unsafe(
        "CREATE TABLE ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const m of MIGRATIONS.slice(0, 7)) {
        await db.a.unsafe(m.sql);
        await db.a.unsafe("INSERT INTO ta_migrations (name) VALUES ($1)", [m.name]);
      }
      const at = new Date("2026-10-14T00:00:00.000Z");
      await db.a.unsafe(
        `INSERT INTO ta_totp (id, created_at, updated_at, user_id, secret, enabled_at, last_step, backup_codes)
         VALUES ('f1', $1, $1, 'u1', 'sealed', $1, 5, '["h1","h2"]'::jsonb),
                ('f2', $1, $1, 'u2', 'sealed', NULL, 0, '["h3"]'::jsonb)`,
        [at],
      );
      expect(await applyPostgresMigrations(db.a)).toEqual(["0008_schema_v8"]);
      expect(
        await db.a.unsafe(
          "SELECT id, user_id, enabled_at, methods, backup_codes, backup_codes_version FROM ta_second_factor",
        ),
      ).toEqual([
        {
          id: "f1",
          user_id: "u1",
          enabled_at: at,
          methods: ["totp"],
          backup_codes: ["h1", "h2"],
          backup_codes_version: 1,
        },
      ]);
      const meta = await db.a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(meta[0]?.value).toBe("8");
    } finally {
      await db.close();
    }
  });
});
