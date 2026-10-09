import { env } from "cloudflare:test";
import { TABLES } from "@tempo-auth/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("d1 undo log", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("restores a row that was updated and then deleted in the same failing transaction (Review Focus 3)", async () => {
    const db = createD1Adapter(env.DB);
    await db.create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: "Ada",
      image: null,
      createdAt: t0,
      updatedAt: t0,
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Changed" });
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    expect(row).toMatchObject({ id: "u1", name: "Ada", email: "a@example.com" });
  });

  it("removes a row created and then updated in a failing transaction", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findMany("user", [])).toEqual([]);
  });

  it("a nested transaction shares the undo log and the outer throw reverses both", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        await tx.transaction(async (inner) => {
          await inner.create("user", {
            id: "u2",
            email: "b@example.com",
            emailVerified: false,
            name: null,
            image: null,
            createdAt: t0,
            updatedAt: t0,
          });
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findMany("user", [])).toEqual([]);
  });
});
