import { describe, expect, it } from "vitest";
import { runAdapterConformance } from "../src/storage/conformance.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

runAdapterConformance("memory", async () => ({
  adapter: createMemoryAdapter(),
  close: async () => {},
}));

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
