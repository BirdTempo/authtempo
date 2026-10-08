import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserRow, VerificationRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "./port.js";

export interface ConformanceTarget {
  adapter: StorageAdapter;
  close(): Promise<void>;
}

function user(id: string, email: string, at: Date): UserRow {
  return { id, email, emailVerified: false, name: null, image: null, createdAt: at, updatedAt: at };
}

function verification(id: string, at: Date, consumedAt: Date | null): VerificationRow {
  return {
    id,
    purpose: "magic-link",
    identifier: "a@example.com",
    valueHash: `hash-${id}`,
    expiresAt: new Date(at.getTime() + 60_000),
    consumedAt,
    data: { next: "/home", n: 1 },
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The contract every adapter must pass. Call it from the adapter's own test
 * file with a factory that opens a fresh, empty database.
 */
export function runAdapterConformance(
  name: string,
  factory: () => Promise<ConformanceTarget>,
): void {
  describe(`storage conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let db: StorageAdapter;
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    beforeEach(async () => {
      target = await factory();
      db = target.adapter;
    });
    afterEach(async () => {
      await target.close();
    });

    it("creates and finds one by eq", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      const found = await db.findOne("user", [
        { field: "email", op: "eq", value: "a@example.com" },
      ]);
      expect(found?.id).toBe("u1");
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.createdAt.getTime()).toBe(t0.getTime());
    });

    it("returns null when nothing matches", async () => {
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "nope" }])).toBeNull();
    });

    it("round-trips null, boolean, integer, and json fields", async () => {
      await db.create("verification", verification("v1", t0, null));
      const row = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      expect(row?.consumedAt).toBeNull();
      expect(row?.data).toEqual({ next: "/home", n: 1 });
      await db.create("user", { ...user("u1", "a@example.com", t0), emailVerified: true });
      const u = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(u?.emailVerified).toBe(true);
    });

    it("findMany supports in, gt, sort, and limit", async () => {
      for (let i = 1; i <= 5; i++) {
        await db.create(
          "user",
          user(`u${i}`, `${i}@example.com`, new Date(t0.getTime() + i * 1000)),
        );
      }
      const some = await db.findMany("user", [
        { field: "id", op: "in", value: ["u1", "u3", "u9"] },
      ]);
      expect(some.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
      const later = await db.findMany(
        "user",
        [{ field: "createdAt", op: "gt", value: new Date(t0.getTime() + 2000) }],
        { sort: { field: "createdAt", dir: "desc" }, limit: 2 },
      );
      expect(later.map((r) => r.id)).toEqual(["u5", "u4"]);
    });

    it("matches eq null and ne null", async () => {
      await db.create("verification", verification("v1", t0, null));
      await db.create("verification", verification("v2", t0, t0));
      const open = await db.findMany("verification", [
        { field: "consumedAt", op: "eq", value: null },
      ]);
      expect(open.map((r) => r.id)).toEqual(["v1"]);
      const spent = await db.findMany("verification", [
        { field: "consumedAt", op: "ne", value: null },
      ]);
      expect(spent.map((r) => r.id)).toEqual(["v2"]);
    });

    it("update returns the count and a conditional update returns 0 when nothing matches", async () => {
      await db.create("verification", verification("v1", t0, null));
      const first = await db.update(
        "verification",
        [
          { field: "valueHash", op: "eq", value: "hash-v1" },
          { field: "consumedAt", op: "eq", value: null },
        ],
        { consumedAt: t0 },
      );
      expect(first).toBe(1);
      const second = await db.update(
        "verification",
        [
          { field: "valueHash", op: "eq", value: "hash-v1" },
          { field: "consumedAt", op: "eq", value: null },
        ],
        { consumedAt: t0 },
      );
      expect(second).toBe(0);
    });

    it("delete returns the count", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await db.create("user", user("u2", "b@example.com", t0));
      expect(await db.delete("user", [{ field: "id", op: "in", value: ["u1", "u2"] }])).toBe(2);
      expect(await db.delete("user", [{ field: "id", op: "eq", value: "u1" }])).toBe(0);
    });

    it("rejects a unique violation with StorageError", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(db.create("user", user("u2", "a@example.com", t0))).rejects.toMatchObject({
        name: "StorageError",
        code: "unique_violation",
        model: "user",
      });
      await expect(db.create("user", user("u2", "a@example.com", t0))).rejects.toBeInstanceOf(
        StorageError,
      );
    });

    it("rolls back a transaction when the function throws", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.create("user", user("u1", "a@example.com", t0));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).toBeNull();
    });

    it("commits a transaction and returns its value", async () => {
      const value = await db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com", t0));
        return 42;
      });
      expect(value).toBe(42);
      expect((await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]))?.id).toBe("u1");
    });

    it("rejects an unknown field", async () => {
      await expect(
        db.findOne("user", [{ field: "nope" as "id", op: "eq", value: 1 }]),
      ).rejects.toMatchObject({ code: "unknown_field" });
    });
  });
}
