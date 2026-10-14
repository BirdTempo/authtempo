import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// Migration 0008 (plan 12c) copies each enabled ta_totp row into
// ta_second_factor with the same id. A backup code hash is keyed by the row
// id (spec 8.11 item 3), so the same id keeps every stored code valid. The
// test runs the copy statement as the migration ships it, on rows that the
// adapter wrote, so the JSON text of `methods` must equal the adapter's own
// encoding of a json field.

const at = new Date("2026-10-14T00:00:00.000Z");

/** The INSERT ... SELECT statement of 0008_schema_v8, as the file ships it. */
function copyStatement(): string {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0008_"));
  const q = m?.queries.find((s) => s.includes("INSERT INTO ta_second_factor"));
  if (!q) throw new Error("0008_schema_v8 has no copy statement");
  return q;
}

function totpRow(id: string, userId: string, enabledAt: Date | null, backupCodes: string[]) {
  return {
    id,
    userId,
    secret: "sealed",
    enabledAt,
    lastStep: 5,
    backupCodes,
    createdAt: at,
    updatedAt: at,
  };
}

beforeEach(async () => {
  await env.DB.batch(
    ["ta_second_factor", "ta_totp", "ta_user"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

it("copies each enabled totp row with the same id and version 1, and skips an unconfirmed setup (plan 12c)", async () => {
  const db = createD1Adapter(env.DB);
  await db.create("totp", totpRow("f1", "u1", at, ["h1", "h2"]));
  await db.create("totp", totpRow("f2", "u2", null, ["h3"]));
  await env.DB.prepare(copyStatement()).run();
  expect(await db.findMany("secondFactor", [])).toEqual([
    {
      id: "f1",
      userId: "u1",
      enabledAt: at,
      methods: ["totp"],
      backupCodes: ["h1", "h2"],
      backupCodesVersion: 1,
      createdAt: at,
      updatedAt: at,
    },
  ]);
});
