import { env } from "cloudflare:test";
import { runShapeConformance, type ShapeSide } from "@authtempo/core/shape-conformance";
import { SQLITE } from "@authtempo/core/sql";
import { D1_SHAPE_SQL, expectedD1Shape, parseD1Shape } from "../src/index.js";

/** The live shape and the version row of `db`, read with the two exported SQL texts. */
async function side(db: D1Database): Promise<ShapeSide> {
  const columns = await db.prepare(D1_SHAPE_SQL.columns).all();
  const indexes = await db.prepare(D1_SHAPE_SQL.indexes).all();
  const row = await db
    .prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'")
    .first<{ value: string }>();
  return { shape: parseD1Shape(columns.results, indexes.results), version: row?.value ?? null };
}

/** Drops every `ta_` table of `db`, so the DDL runs on an empty database. */
async function dropAll(db: D1Database): Promise<void> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  if (tables.results.length === 0) return;
  await db.batch(tables.results.map((t) => db.prepare(`DROP TABLE ${t.name}`)));
}

// `shipped` reads env.DB, which test/setup.ts migrates with the shipped
// files through applyD1Migrations. `fromDdl` runs the DDL on DDL_DB.
runShapeConformance("d1", async () => ({
  dialect: SQLITE,
  expected: expectedD1Shape(),
  shipped: () => side(env.DB),
  async fromDdl(statements) {
    await dropAll(env.DDL_DB);
    await env.DDL_DB.batch(statements.map((s) => env.DDL_DB.prepare(s)));
    return side(env.DDL_DB);
  },
  close: () => dropAll(env.DDL_DB),
}));
