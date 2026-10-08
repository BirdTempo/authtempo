import { describe, expect, it } from "vitest";
import { findOrCreateUserByEmail, normalizeEmail } from "../src/engine/users.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

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
});
