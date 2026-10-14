import { applyD1Migrations, env } from "cloudflare:test";
import { type ModelName, schema } from "@authtempo/core";
import { columnName, encodeValue, SQLITE, TABLES } from "@authtempo/core/sql";
import { expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The migration proof of plan 12b on D1: rows that a database at schema
// version 8 holds read as secret version 1 after migration 0009. It also
// proves that D1 runs ADD COLUMN ... NOT NULL DEFAULT 1 on a table with rows.

const AT = new Date("2026-10-14T00:00:00.000Z");

/** One row of each keyed model, as a version 8 database holds it: no secretVersion. */
const ROWS: Array<{ model: ModelName; row: Record<string, unknown> }> = [
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
async function insertOld(
  db: D1Database,
  model: ModelName,
  row: Record<string, unknown>,
): Promise<void> {
  const fields = Object.keys(schema[model].fields).filter((f) => f !== "secretVersion");
  const types = schema[model].fields as Record<string, { type: Parameters<typeof encodeValue>[1] }>;
  const params = fields.map((f) =>
    encodeValue(SQLITE, types[f]?.type ?? "string", row[f], model, f),
  );
  const cols = fields.map(columnName).join(", ");
  await db
    .prepare(`INSERT INTO ${TABLES[model]} (${cols}) VALUES (${fields.map(() => "?").join(", ")})`)
    .bind(...params)
    .run();
}

it("a row written before the migration reads secretVersion 1 after 0009 (plan 12b)", async () => {
  const at8 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0009_"));
  expect(at8).toBe(8);
  await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, at8));
  for (const { model, row } of ROWS) await insertOld(env.STAGED, model, row);
  await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
  const db = createD1Adapter(env.STAGED);
  for (const { model, row } of ROWS) {
    const read = await db.findOne(model, [{ field: "id", op: "eq", value: row.id }]);
    // A read of one model of the union: name the one field that every keyed row has.
    const secretVersion = (read as { secretVersion?: unknown } | null)?.secretVersion;
    expect({ model, secretVersion }).toEqual({ model, secretVersion: 1 });
  }
});
