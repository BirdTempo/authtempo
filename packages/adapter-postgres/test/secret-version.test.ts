import { type ModelName, schema } from "@authtempo/core";
import { columnName, encodeValue, POSTGRES, TABLES } from "@authtempo/core/sql";
import type { Sql } from "postgres";
import { expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { applyPostgresMigrations, MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

// The migration proof of plan 12b on Postgres: rows that a database at
// schema version 8 holds read as secret version 1 after migration 0009.

const AT = new Date("2026-10-14T00:00:00.000Z");

/** The four models that hold a sealed value or a keyed hash: each row has secretVersion. */
type KeyedModel = Extract<ModelName, "totp" | "verification" | "jwk" | "secondFactor">;

/** One row of each keyed model, as a version 8 database holds it: no secretVersion. */
const ROWS: Array<{ model: KeyedModel; row: Record<string, unknown> }> = [
  {
    model: "totp",
    row: {
      id: "f1",
      userId: "u1",
      secret: "sealed",
      enabledAt: AT,
      lastStep: 0,
      backupCodes: [],
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    model: "verification",
    row: {
      id: "v1",
      purpose: "email-otp",
      identifier: "a@example.com",
      valueHash: "h",
      expiresAt: AT,
      consumedAt: null,
      data: { attempts: 0 },
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    model: "jwk",
    row: {
      id: "k1",
      publicJwk: { kty: "OKP" },
      privateKey: "sealed",
      slot: "signing",
      retiredAt: null,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    model: "secondFactor",
    row: {
      id: "s1",
      userId: "u1",
      enabledAt: AT,
      methods: ["totp"],
      backupCodes: ["h1"],
      backupCodesVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  },
];

/** An INSERT of every field but secretVersion, in the dialect's encoding. */
async function insertOld(sql: Sql, model: ModelName, row: Record<string, unknown>): Promise<void> {
  const fields = Object.keys(schema[model].fields).filter((f) => f !== "secretVersion");
  const types = schema[model].fields as Record<string, { type: Parameters<typeof encodeValue>[1] }>;
  const params = fields.map((f) =>
    encodeValue(POSTGRES, types[f]?.type ?? "string", row[f], model, f),
  );
  const cols = fields.map(columnName).join(", ");
  const marks = fields.map((_, i) => `$${i + 1}`).join(", ");
  await sql.unsafe(`INSERT INTO ${TABLES[model]} (${cols}) VALUES (${marks})`, params as never[]);
}

it("a row written before the migration reads secretVersion 1 after 0009 (plan 12b)", async () => {
  const { a: sql, close } = await freshSchema();
  try {
    // The runner's own table and the first eight migrations, as a version 8 database has them.
    await sql.unsafe(
      "CREATE TABLE ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const i0009 = MIGRATIONS.findIndex((m) => m.name === "0009_schema_v9");
    expect(i0009).toBe(8);
    for (const m of MIGRATIONS.slice(0, i0009)) {
      await sql.unsafe(m.sql);
      await sql.unsafe("INSERT INTO ta_migrations (name) VALUES ($1)", [m.name]);
    }
    for (const { model, row } of ROWS) await insertOld(sql, model, row);
    // The runner applies 0009 and each later migration (0010 since plan 12a, 0011 since plan 12e, 0012 since plan 12f,
    // 0013 since plan 12k, 0014 since plan 12d).
    expect(await applyPostgresMigrations(sql)).toEqual([
      "0009_schema_v9",
      "0010_schema_v10",
      "0011_schema_v11",
      "0012_schema_v12",
      "0013_schema_v13",
      "0014_schema_v14",
    ]);
    const db = createPostgresAdapter(sql);
    for (const { model, row } of ROWS) {
      const read = await db.findOne(model, [{ field: "id", op: "eq", value: row.id }]);
      expect({ model, secretVersion: read?.secretVersion }).toEqual({ model, secretVersion: 1 });
    }
  } finally {
    await close();
  }
});
