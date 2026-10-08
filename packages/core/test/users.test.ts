import { describe, expect, it } from "vitest";
import { findOrCreateUserByEmail, normalizeEmail } from "../src/engine/users.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";

/**
 * A wrapper whose first user read inside a transaction misses. On that miss
 * it commits the winner through the outer adapter, as a concurrent request on
 * another connection would. The transaction's create then fails with
 * unique_violation, and the winner row stays because a rollback reverses only
 * the transaction's own writes.
 */
function concurrentWinner(inner: StorageAdapter, winner: UserRow): StorageAdapter {
  let missed = false;
  const wrap = (a: StorageAdapter): StorageAdapter => ({
    create: (m, d) => a.create(m, d),
    findOne: async (m, w) => {
      if (m === "user" && !missed) {
        missed = true;
        await inner.create("user", winner);
        return null;
      }
      return a.findOne(m, w);
    },
    findMany: (m, w, o) => a.findMany(m, w, o),
    update: (m, w, d) => a.update(m, w, d),
    delete: (m, w) => a.delete(m, w),
    transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });
  it("rejects shapes that are not an address", () => {
    for (const bad of [
      "",
      "ada",
      "ada@",
      "@example.com",
      "a b@example.com",
      "a@b",
      `${"a".repeat(255)}@example.com`,
    ]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe("findOrCreateUserByEmail", () => {
  it("creates a verified user with an email identity, once", async () => {
    const db = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00Z");
    const first = await findOrCreateUserByEmail(db, "ada@example.com", now);
    expect(first.created).toBe(true);
    expect(first.user.emailVerified).toBe(true);
    const second = await findOrCreateUserByEmail(db, "ada@example.com", now);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(await db.findMany("user", [])).toHaveLength(1);
    const identities = await db.findMany("identity", [
      { field: "userId", op: "eq", value: first.user.id },
    ]);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ provider: "email", subject: "ada@example.com" });
  });

  it("marks an existing unverified user as verified", async () => {
    const db = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00Z");
    await db.create("user", {
      id: "u1",
      email: "ada@example.com",
      emailVerified: false,
      name: "Ada",
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const { user, created } = await findOrCreateUserByEmail(db, "ada@example.com", now);
    expect(created).toBe(false);
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe("Ada");
  });

  it("two concurrent calls for one new address both resolve to one user", async () => {
    const db = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00Z");
    const [a, b] = await Promise.all([
      findOrCreateUserByEmail(db, "ada@example.com", now),
      findOrCreateUserByEmail(db, "ada@example.com", now),
    ]);
    expect(a.user.id).toBe(b.user.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await db.findMany("user", [])).toHaveLength(1);
    expect(await db.findMany("identity", [])).toHaveLength(1);
  });

  it("returns the winner when a create fails with unique_violation", async () => {
    const real = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00Z");
    const winner: UserRow = {
      id: "u-winner",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    };
    const { user, created } = await findOrCreateUserByEmail(
      concurrentWinner(real, winner),
      "ada@example.com",
      now,
    );
    expect(created).toBe(false);
    expect(user.id).toBe("u-winner");
    expect(await real.findMany("user", [])).toHaveLength(1);
  });
});
