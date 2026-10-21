import { describe, expect, it } from "vitest";
import { runAdapterConformance } from "../src/storage/conformance.js";
import { createMemoryAdapter, sameUniqueKey } from "../src/storage/memory.js";

// Each adapter of this repository has ping (plan 12h Task 8).
runAdapterConformance(
  "memory",
  async () => ({
    adapter: createMemoryAdapter(),
    close: async () => {},
  }),
  { ping: true },
);

describe("memory adapter transactions", () => {
  it("runs transactions one at a time, so a read-then-create never collides", async () => {
    const db = createMemoryAdapter();
    const at = new Date("2026-01-01T00:00:00.000Z");
    const findOrCreate = (id: string) =>
      db.transaction(async (tx) => {
        const found = await tx.findOne("user", [
          { field: "email", op: "eq", value: "a@example.com" },
        ]);
        if (found) return found;
        return tx.create("user", {
          id,
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          bannedAt: null,
          banReason: null,
          banUntil: null,
          createdAt: at,
          updatedAt: at,
        });
      });
    // The conformance suite allows one unique_violation. Memory serializes, so it has none.
    const [a, b] = await Promise.all([findOrCreate("u1"), findOrCreate("u2")]);
    expect(a.id).toBe("u1");
    expect(b.id).toBe("u1");
  });
});

/**
 * No unique key in the schema has a nullable field today, so the conformance
 * suite cannot pin this rule without a row the product cannot write. This
 * pins the memory adapter's key compare directly.
 */
describe("memory adapter unique keys", () => {
  it("never treats null as a conflict, in a single or a composite key", () => {
    expect(sameUniqueKey(["a"], { a: null }, { a: null })).toBe(false);
    expect(sameUniqueKey(["a"], { a: undefined }, { a: null })).toBe(false);
    expect(sameUniqueKey(["a", "b"], { a: 1, b: null }, { a: 1, b: null })).toBe(false);
    expect(sameUniqueKey(["a", "b"], { a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(sameUniqueKey(["a"], { a: "x" }, { a: "y" })).toBe(false);
  });
});
