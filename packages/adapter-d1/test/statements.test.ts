import { env } from "cloudflare:test";
import { StorageError } from "@tempo-auth/core";
import { coreStatements, SQLITE, type SqlStatements, TABLES } from "@tempo-auth/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1AdapterOn, toStorageError } from "../src/index.js";

type Counts = Record<keyof SqlStatements, number>;

function counting(): { statements: SqlStatements; counts: Counts } {
  const base = coreStatements(SQLITE);
  const counts = Object.fromEntries(Object.keys(base).map((k) => [k, 0])) as Counts;
  const statements = Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        counts[k as keyof SqlStatements]++;
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as SqlStatements;
  return { statements, counts };
}

const at = new Date("2026-10-10T00:00:00.000Z");
const user = (id: string, email: string) => ({
  id,
  email,
  emailVerified: false,
  name: null,
  image: null,
  createdAt: at,
  updatedAt: at,
});

describe("the D1 statements seam", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("routes every statement and every undo entry through the given statements", async () => {
    const { statements, counts } = counting();
    const db = createD1AdapterOn(env.DB, { statements, toStorageError, ready: async () => {} });
    await db.create("user", user("u1", "a@example.com"));
    await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u2", "b@example.com"));
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(counts).toMatchObject({
      insert: 2,
      select: 1,
      update: 1,
      undoSelect: 1,
      deleteReturning: 1,
      undoCreate: 1,
      restoreRow: 1,
      reinsertRow: 1,
    });
    expect(counts.decode).toBeGreaterThanOrEqual(1);
    const back = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    expect(back?.name).toBeNull();
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u2" }])).toBeNull();
  });

  it("maps a unique violation through the given toStorageError", async () => {
    const seen: unknown[] = [];
    const db = createD1AdapterOn(env.DB, {
      statements: coreStatements(SQLITE),
      // A field list the package's own mapping never builds. An adapter that
      // ignores this option answers ["email"], so this test fails then.
      toStorageError: (model, err) => {
        seen.push(err);
        return new StorageError("unique_violation", model, ["marker"]);
      },
      ready: async () => {},
    });
    await db.create("user", user("u1", "a@example.com"));
    await expect(db.create("user", user("u2", "a@example.com"))).rejects.toMatchObject({
      code: "unique_violation",
      fields: ["marker"],
    });
    expect(seen).toHaveLength(1);
  });
});
