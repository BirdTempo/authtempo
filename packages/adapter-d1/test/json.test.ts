import { env } from "cloudflare:test";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

const row = (id: string, valueHash: string, data: Record<string, unknown> | null) => ({
  id,
  purpose: "magic-link" as const,
  identifier: "a@example.com",
  valueHash,
  expiresAt: t0,
  consumedAt: null,
  data,
  createdAt: t0,
  updatedAt: t0,
});

// Review Focus 2 on this adapter: quote, backslash, and unicode survive a round trip.
const tricky = { q: "it's", b: "a\\b", u: "é 😀", n: [1, { z: null }] };

describe("d1 json values", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("round-trips quote, backslash, unicode, and nesting through create and update", async () => {
    const db = createD1Adapter(env.DB);
    await db.create("verification", row("v1", "h1", tricky));
    const read = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
    expect(read?.data).toEqual(tricky);
    await db.create("verification", row("v2", "h2", null));
    await db.update("verification", [{ field: "id", op: "eq", value: "v2" }], { data: tricky });
    const updated = await db.findOne("verification", [{ field: "id", op: "eq", value: "v2" }]);
    expect(updated?.data).toEqual(tricky);
  });

  it("rejects a NUL character in json with invalid_argument and stores nothing", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.create("verification", row("v1", "h1", { a: "x\u0000y" })),
    ).rejects.toMatchObject({ name: "StorageError", code: "invalid_argument" });
    expect(await db.findMany("verification", [])).toEqual([]);
  });
});
