import { describe, expect, it } from "vitest";
import { claimEmail, findOrCreateUserByEmail, normalizeEmail } from "../src/engine/users.js";
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

describe("normalizeEmail control characters (plan 3 input)", () => {
  it("returns null for a NUL, a newline, a tab, and DEL", () => {
    for (const bad of [
      "a\u0000@example.com",
      "a\n@example.com",
      "a\t@example.com",
      "a\u007f@example.com",
    ]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail("Ada@Example.com")).toBe("ada@example.com");
  });
});

describe("findOrCreateUserByEmail repairs a missing email identity (plan 3 input)", () => {
  it("creates the email identity when the user exists without one", async () => {
    const storage = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await storage.create("user", {
      id: "01USER",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(await storage.findMany("identity", [])).toHaveLength(0);
    const { user, created } = await findOrCreateUserByEmail(storage, "ada@example.com", now);
    expect(created).toBe(false);
    expect(user.id).toBe("01USER");
    const identities = await storage.findMany("identity", []);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      userId: "01USER",
      provider: "email",
      subject: "ada@example.com",
    });
    await findOrCreateUserByEmail(storage, "ada@example.com", now);
    expect(await storage.findMany("identity", [])).toHaveLength(1);
  });
});

describe("claimEmail covers passkeys (plan 4 input)", () => {
  it("deletes the user's passkeys and pending passkey challenges", async () => {
    // Registration refuses an unverified user, so the product never creates these rows for U1. The deletes are a second guard; this test pins that guard only.
    const storage = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = { createdAt: now, updatedAt: now };
    await storage.create("user", {
      id: "U1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      ...row,
    });
    await storage.create("passkey", {
      id: "P1",
      userId: "U1",
      credentialId: "c1",
      publicKey: "k",
      counter: 0,
      transports: null,
      deviceType: "singleDevice",
      backedUp: false,
      name: null,
      ...row,
    });
    await storage.create("user", {
      id: "U2",
      email: "b@example.com",
      emailVerified: true,
      name: null,
      image: null,
      ...row,
    });
    await storage.create("passkey", {
      id: "P2",
      userId: "U2",
      credentialId: "c2",
      publicKey: "k",
      counter: 0,
      transports: null,
      deviceType: "singleDevice",
      backedUp: false,
      name: null,
      ...row,
    });
    await storage.create("verification", {
      id: "V1",
      purpose: "passkey-challenge",
      identifier: "U1",
      valueHash: "h1",
      expiresAt: now,
      consumedAt: null,
      data: { kind: "registration" },
      ...row,
    });
    await storage.create("verification", {
      id: "V2",
      purpose: "passkey-challenge",
      identifier: "sign-in",
      valueHash: "h2",
      expiresAt: now,
      consumedAt: null,
      data: { kind: "authentication" },
      ...row,
    });
    await storage.transaction((tx) => claimEmail(tx, "U1", null, now));
    expect((await storage.findMany("passkey", [])).map((p) => p.id)).toEqual(["P2"]);
    expect((await storage.findMany("verification", [])).map((v) => v.id)).toEqual(["V2"]);
    expect(
      (await storage.findOne("user", [{ field: "id", op: "eq", value: "U1" }]))?.emailVerified,
    ).toBe(true);
  });
});

describe("claimEmail covers handoff codes (plan 5a input)", () => {
  it("deletes the user's handoff code rows and keeps the start rows and other users' rows", async () => {
    const storage = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = { createdAt: now, updatedAt: now, expiresAt: now, consumedAt: null };
    await storage.create("user", {
      id: "U1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await storage.create("verification", {
      id: "H1",
      purpose: "handoff-code",
      identifier: "U1",
      valueHash: "c1",
      data: { challenge: "x", redirect: "app://auth" },
      ...row,
    });
    await storage.create("verification", {
      id: "H2",
      purpose: "handoff-code",
      identifier: "U2",
      valueHash: "c2",
      data: { challenge: "y", redirect: "app://auth" },
      ...row,
    });
    await storage.create("verification", {
      id: "H3",
      purpose: "handoff-code",
      identifier: "start",
      valueHash: "s1",
      data: { challenge: "z", redirect: "app://auth" },
      ...row,
    });
    await storage.transaction((tx) => claimEmail(tx, "U1", null, now));
    expect((await storage.findMany("verification", [])).map((v) => v.id).sort()).toEqual([
      "H2",
      "H3",
    ]);
  });
});

describe("claimEmail and the password row (plan 8)", () => {
  async function unverifiedWithPassword() {
    const storage = createMemoryAdapter();
    const now = new Date("2026-10-10T00:00:00Z");
    await storage.create("user", {
      id: "u1",
      email: "ada@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await storage.create("password", {
      id: "p1",
      userId: "u1",
      hash: "h",
      createdAt: now,
      updatedAt: now,
    });
    return { storage, now };
  }
  const ofUser = [{ field: "userId", op: "eq", value: "u1" }] as const;

  it("deletes the user's password row when nothing is kept", async () => {
    const { storage, now } = await unverifiedWithPassword();
    await storage.transaction((tx) => claimEmail(tx, "u1", null, now));
    expect(await storage.findMany("password", [...ofUser])).toEqual([]);
  });

  it("keeps the password row that keep.passwordId names", async () => {
    const { storage, now } = await unverifiedWithPassword();
    await storage.transaction((tx) => claimEmail(tx, "u1", { passwordId: "p1" }, now));
    expect(
      await storage.findOne("password", [{ field: "id", op: "eq", value: "p1" }]),
    ).not.toBeNull();
  });

  it("deletes the password rows before the sessions", async () => {
    const { storage, now } = await unverifiedWithPassword();
    const order: string[] = [];
    await storage.transaction((tx) => {
      const recording: StorageAdapter = {
        ...tx,
        delete: async (m, w) => {
          order.push(m);
          return tx.delete(m, w);
        },
      };
      return claimEmail(recording, "u1", null, now);
    });
    expect(order.indexOf("password")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("password")).toBeLessThan(order.indexOf("session"));
  });
});
