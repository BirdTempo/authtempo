import { describe, expect, it } from "vitest";
import { runAdapterConformance } from "../src/storage/conformance.js";
import { createMemoryAdapter, sameUniqueKey } from "../src/storage/memory.js";

// Each adapter of this repository has ping (plan 12h Task 8). Memory has
// no isolation, so a claim on it needs the undo guard (decision 6 of plan 12q).
runAdapterConformance(
  "memory",
  async () => ({
    adapter: createMemoryAdapter(),
    close: async () => {},
  }),
  { ping: true, undoGuard: true },
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
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
 * The undo guard of a claim (decision 6 of plan 12q). The conformance suite
 * holds the call on every store. This holds the order of the undo on
 * memory: each step reads the condition when it runs, so the undo of the
 * flip, which runs first, makes the condition hold again.
 */
describe("memory adapter undo guard", () => {
  const at = new Date("2026-11-05T00:00:00.000Z");
  const byId = [{ field: "id" as const, op: "eq" as const, value: "u1" }];
  const unverified = [
    ...byId,
    { field: "emailVerified" as const, op: "eq" as const, value: false },
  ];
  const seed = async (db: ReturnType<typeof createMemoryAdapter>) => {
    await db.create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: at,
      updatedAt: at,
    });
    await db.create("password", {
      id: "p1",
      userId: "u1",
      hash: "pbkdf2$hash",
      createdAt: at,
      updatedAt: at,
    });
  };
  const passwords = (db: ReturnType<typeof createMemoryAdapter>) =>
    db.findMany("password", [{ field: "userId", op: "eq", value: "u1" }]);

  it("puts the row back when the undo of the flip runs first, as after a lost answer at the session delete (U2)", async () => {
    const db = createMemoryAdapter();
    await seed(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.undoOnlyWhile?.("user", unverified);
        await tx.delete("password", [{ field: "userId", op: "eq", value: "u1" }]);
        // The flip of the claim, in the transaction: its undo step runs first.
        await tx.update("user", unverified, { emailVerified: true });
        throw new Error("the session delete lost its answer");
      }),
    ).rejects.toThrow("the session delete lost its answer");
    expect((await db.findOne("user", byId))?.emailVerified).toBe(false);
    expect((await passwords(db)).map((r) => r.id)).toEqual(["p1"]);
  });

  it("keeps the row gone when the flip has no undo step, as after a lost answer at the flip (U1)", async () => {
    const db = createMemoryAdapter();
    await seed(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.undoOnlyWhile?.("user", unverified);
        await tx.delete("password", [{ field: "userId", op: "eq", value: "u1" }]);
        // The flip lands outside the undo log, as a D1 write whose answer is lost.
        await db.update("user", unverified, { emailVerified: true });
        throw new Error("the flip lost its answer");
      }),
    ).rejects.toThrow("the flip lost its answer");
    expect((await db.findOne("user", byId))?.emailVerified).toBe(true);
    expect(await passwords(db)).toEqual([]);
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
