import { runShapeConformance, type ShapeSide } from "@authtempo/core/shape-conformance";
import { POSTGRES } from "@authtempo/core/sql";
import type { Sql } from "postgres";
import { expectedPostgresShape, readPostgresShape } from "../src/index.js";
import { freshDatabase, freshSchema } from "./db.js";

/** The live shape and the version row of the schema that `sql` reads. */
async function side(sql: Sql): Promise<ShapeSide> {
  const rows = await sql.unsafe<{ value: string }[]>(
    "SELECT value FROM ta_meta WHERE key = 'schema_version'",
  );
  return { shape: await readPostgresShape(sql), version: rows[0]?.value ?? null };
}

// Each side is its own schema, which `close` drops. `shipped` runs the steps
// of the runner without its advisory lock (test/db.ts, ruling 53 of plan 12k).
runShapeConformance("postgres", async () => {
  const closers: (() => Promise<void>)[] = [];
  return {
    dialect: POSTGRES,
    expected: expectedPostgresShape(),
    async shipped() {
      const db = await freshDatabase();
      closers.push(() => db.close());
      return side(db.sql);
    },
    async fromDdl(statements) {
      const db = await freshSchema();
      closers.push(() => db.close());
      for (const s of statements) await db.a.unsafe(s);
      return side(db.a);
    },
    async close() {
      for (const c of closers) await c();
    },
  };
});
