import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

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
  secretVersion: 1,
});

// Review Focus 2 on this adapter: quote, backslash, and unicode survive a round trip.
const tricky = { q: "it's", b: "a\\b", u: "é 😀", n: [1, { z: null }] };

describe("postgres json values", () => {
  it("round-trips quote, backslash, unicode, and nesting through create and update", async () => {
    const pg = await freshDatabase();
    try {
      const db = createPostgresAdapter(pg.sql);
      await db.create("verification", row("v1", "h1", tricky));
      const read = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      expect(read?.data).toEqual(tricky);
      await db.create("verification", row("v2", "h2", null));
      await db.update("verification", [{ field: "id", op: "eq", value: "v2" }], { data: tricky });
      const updated = await db.findOne("verification", [{ field: "id", op: "eq", value: "v2" }]);
      expect(updated?.data).toEqual(tricky);
      // The column holds a jsonb object, not a jsonb string.
      const kinds = await pg.sql.unsafe<{ t: string }[]>(
        "SELECT jsonb_typeof(data) AS t FROM ta_verification ORDER BY id",
      );
      expect(kinds.map((k) => k.t)).toEqual(["object", "object"]);
    } finally {
      await pg.close();
    }
  });

  it("rejects a NUL character in json with invalid_argument and stores nothing", async () => {
    const pg = await freshDatabase();
    try {
      const db = createPostgresAdapter(pg.sql);
      await expect(
        db.create("verification", row("v1", "h1", { a: "x\u0000y" })),
      ).rejects.toMatchObject({ name: "StorageError", code: "invalid_argument" });
      expect(await db.findMany("verification", [])).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});
