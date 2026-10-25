import { describe, expect, it } from "vitest";
import type { VerifySteps } from "../src/engine/create-steps.js";
import {
  claimEmail,
  findOrCreateUserByEmail,
  normalizeEmail,
  validUserName,
} from "../src/engine/users.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { noVerifyHooks } from "./helpers.js";

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
    createMany: (m, r) => a.createMany(m, r),
    rowsPerInsert: (m) => a.rowsPerInsert(m),
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
    const first = await findOrCreateUserByEmail(
      db,
      "ada@example.com",
      now,
      noVerifyHooks("magic_link"),
    );
    expect(first.created).toBe(true);
    expect(first.user.emailVerified).toBe(true);
    const second = await findOrCreateUserByEmail(
      db,
      "ada@example.com",
      now,
      noVerifyHooks("magic_link"),
    );
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    const { user, created } = await findOrCreateUserByEmail(
      db,
      "ada@example.com",
      now,
      noVerifyHooks("magic_link"),
    );
    expect(created).toBe(false);
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe("Ada");
  });

  it("two concurrent calls for one new address both resolve to one user", async () => {
    const db = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00Z");
    const [a, b] = await Promise.all([
      findOrCreateUserByEmail(db, "ada@example.com", now, noVerifyHooks("magic_link")),
      findOrCreateUserByEmail(db, "ada@example.com", now, noVerifyHooks("magic_link")),
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    };
    const { user, created } = await findOrCreateUserByEmail(
      concurrentWinner(real, winner),
      "ada@example.com",
      now,
      noVerifyHooks("magic_link"),
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(await storage.findMany("identity", [])).toHaveLength(0);
    const { user, created } = await findOrCreateUserByEmail(
      storage,
      "ada@example.com",
      now,
      noVerifyHooks("magic_link"),
    );
    expect(created).toBe(false);
    expect(user.id).toBe("01USER");
    const identities = await storage.findMany("identity", []);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      userId: "01USER",
      provider: "email",
      subject: "ada@example.com",
    });
    await findOrCreateUserByEmail(storage, "ada@example.com", now, noVerifyHooks("magic_link"));
    expect(await storage.findMany("identity", [])).toHaveLength(1);
  });
});

/** The verify steps after `user.beforeVerify` ran for the user, as each flow runs it before its claim. */
async function checkedFor(storage: StorageAdapter, userId: string): Promise<VerifySteps> {
  const user = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  if (!user) throw new Error(`no user ${userId}`);
  const verified = noVerifyHooks("magic_link");
  await verified.before(user);
  return verified;
}

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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
      discoverable: null,
      prf: false,
      largeBlob: false,
      name: null,
      ...row,
    });
    await storage.create("user", {
      id: "U2",
      email: "b@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
      discoverable: null,
      prf: false,
      largeBlob: false,
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
      secretVersion: 1,
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
      secretVersion: 1,
    });
    const verified = await checkedFor(storage, "U1");
    await storage.transaction((tx) => claimEmail(tx, "U1", null, now, verified));
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
      secretVersion: 1,
    });
    await storage.create("verification", {
      id: "H2",
      purpose: "handoff-code",
      identifier: "U2",
      valueHash: "c2",
      data: { challenge: "y", redirect: "app://auth" },
      ...row,
      secretVersion: 1,
    });
    await storage.create("verification", {
      id: "H3",
      purpose: "handoff-code",
      identifier: "start",
      valueHash: "s1",
      data: { challenge: "z", redirect: "app://auth" },
      ...row,
      secretVersion: 1,
    });
    const verified = await checkedFor(storage, "U1");
    await storage.transaction((tx) => claimEmail(tx, "U1", null, now, verified));
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
    const verified = await checkedFor(storage, "u1");
    await storage.transaction((tx) => claimEmail(tx, "u1", null, now, verified));
    expect(await storage.findMany("password", [...ofUser])).toEqual([]);
  });

  it("keeps the password row that keep.passwordId names", async () => {
    const { storage, now } = await unverifiedWithPassword();
    const verified = await checkedFor(storage, "u1");
    await storage.transaction((tx) => claimEmail(tx, "u1", { passwordId: "p1" }, now, verified));
    expect(
      await storage.findOne("password", [{ field: "id", op: "eq", value: "p1" }]),
    ).not.toBeNull();
  });

  it("deletes the password rows before the sessions", async () => {
    const { storage, now } = await unverifiedWithPassword();
    const order: string[] = [];
    const verified = await checkedFor(storage, "u1");
    await storage.transaction((tx) => {
      const recording: StorageAdapter = {
        ...tx,
        delete: async (m, w) => {
          order.push(m);
          return tx.delete(m, w);
        },
      };
      return claimEmail(recording, "u1", null, now, verified);
    });
    expect(order.indexOf("password")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("password")).toBeLessThan(order.indexOf("session"));
  });

  it("flips emailVerified in its first statement and deletes the password rows before the sessions (plan 8 final review T3)", async () => {
    // Every sign-up and sign-in guard depends on this order. The
    // interleave tests run whole claims, so a reorder inside claimEmail
    // passes them; this test records each statement.
    const { storage, now } = await unverifiedWithPassword();
    const order: string[] = [];
    const verified = await checkedFor(storage, "u1");
    await storage.transaction((tx) => {
      const recording: StorageAdapter = {
        ...tx,
        findOne: async (m, w) => {
          order.push(`findOne:${m}`);
          return tx.findOne(m, w);
        },
        findMany: async (m, w, o) => {
          order.push(`findMany:${m}`);
          return tx.findMany(m, w, o);
        },
        create: async (m, d) => {
          order.push(`create:${m}`);
          return tx.create(m, d);
        },
        update: async (m, w, d) => {
          order.push(`update:${m}:${JSON.stringify(Object.keys(d))}`);
          return tx.update(m, w, d);
        },
        delete: async (m, w) => {
          order.push(`delete:${m}`);
          return tx.delete(m, w);
        },
      };
      return claimEmail(recording, "u1", null, now, verified);
    });
    // The claim clears the username and the phone in the same statement (ruling 16 M2, final review A M2).
    expect(order[0]).toBe(
      `update:user:["emailVerified","username","displayUsername","phone","updatedAt"]`,
    );
    expect(order.filter((x) => x.startsWith("update:"))).toHaveLength(1);
    const password = order.indexOf("delete:password");
    expect(password).toBeGreaterThan(0);
    expect(password).toBeLessThan(order.indexOf("delete:session"));
  });

  it.each([
    ["no keep", null],
    ["keep.username", { username: true }],
  ] as const)(
    "clears the claimant's phone with %s (final review A M2 of plan 12i)",
    async (_, keep) => {
      // Core sets no phone on an unverified user. The compat store reads one
      // from a Better Auth 1.7.2 row: a sign-up by address, then
      // updatePhoneNumber with phoneNumberVerified true.
      const { storage, now } = await unverifiedWithPassword();
      await storage.update("user", [{ field: "id", op: "eq", value: "u1" }], {
        phone: "+14155550177",
      });
      const verified = await checkedFor(storage, "u1");
      await storage.transaction((tx) => claimEmail(tx, "u1", keep, now, verified));
      const user = await storage.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect({ verified: user?.emailVerified, phone: user?.phone }).toEqual({
        verified: true,
        phone: null,
      });
    },
  );
});

describe("validUserName (exported for the importer, plan 9b)", () => {
  it("holds 1 to 200 characters with no control character", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)),
      String.fromCharCode(0x7f),
    ];
    expect(validUserName("a")).toBe(true);
    expect(validUserName("a".repeat(200))).toBe(true);
    expect(validUserName("Ada Lövelace")).toBe(true);
    expect(validUserName("")).toBe(false);
    expect(validUserName("a".repeat(201))).toBe(false);
    for (const c of controls) expect(validUserName(`Ada${c}x`)).toBe(false);
  });

  // Review L4 of plan 12a Task 7: the rule refuses what makes one name read as another.
  it.each([
    ["a space and a hyphen", "Ada Lovelace-Byron"],
    ["Latin letters with marks", "Zoë Ångström"],
    ["a combining mark", "Ade\u0301le"],
    ["Greek", "Ἀριστοτέλης"],
    ["Cyrillic", "Ада Лавлейс"],
    ["Arabic letters", "أدا لوفليس"],
    ["Hebrew letters", "עדה"],
    ["CJK", "艾达·洛夫莱斯"],
    ["Devanagari", "अदा"],
    ["an emoji of one code point", "Ada 🚀"],
    ["an emoji with a skin tone", "Ada 👍🏽"],
    ["a no-break space", "Ada\u00a0Lovelace"],
    // The lead's ruling: Persian names and joined emoji carry these two format characters.
    ["a Persian name with a zero-width non-joiner", "مهسا\u200cسادات"],
    ["a zero-width non-joiner", "A\u200cda"],
    ["a zero-width joiner", "A\u200dda"],
    ["an emoji joined by a zero-width joiner", "Ada 👩\u200d💻"],
  ])("takes a name with %s", (_, name) => {
    expect(validUserName(name)).toBe(true);
  });

  it.each([
    ["a C1 control (NEL)", "Ada\u0085x"],
    ["a C1 control (CSI)", "Ada\u009bx"],
    ["a C1 control (APC)", "Ada\u009fx"],
    ["a right-to-left override", "\u202eadA"],
    ["a left-to-right mark", "Ada\u200e"],
    ["a right-to-left isolate", "Ada\u2067x"],
    ["a pop directional isolate", "Ada\u2069"],
    ["an Arabic letter mark", "Ada\u061c"],
    ["a zero-width space", "A\u200bda"],
    ["a word joiner", "A\u2060da"],
    ["a byte order mark", "\ufeffAda"],
    ["a soft hyphen", "A\u00adda"],
    ["a tag character", "Ada\u{e0041}"],
    ["a lone high surrogate", "Ada\ud800"],
    ["a lone low surrogate", "Ada\udc00"],
    ["a line separator", "Ada\u2028x"],
    ["a paragraph separator", "Ada\u2029x"],
  ])("refuses a name with %s", (_, name) => {
    expect(validUserName(name)).toBe(false);
  });

  // Review L1 of plan 12a Task 7: an array has a length and reads as text.
  it.each([
    ["an array", ["Ada"]],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { length: 3 }],
  ])("refuses %s, which is not a string", (_, value) => {
    expect(validUserName(value as unknown as string)).toBe(false);
  });
});

describe("claimEmail needs user.beforeVerify first (plan 12a, Task 18)", () => {
  async function unverified() {
    const storage = createMemoryAdapter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (const id of ["u1", "u2"])
      await storage.create("user", {
        id,
        email: `${id}@example.com`,
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
        createdAt: now,
        updatedAt: now,
      });
    return { storage, now };
  }

  it("throws and writes nothing when before did not run, or ran for another user", async () => {
    const { storage, now } = await unverified();
    const message = "authtempo: user.beforeVerify did not run before the claim";
    await expect(
      storage.transaction((tx) => claimEmail(tx, "u1", null, now, noVerifyHooks("magic_link"))),
    ).rejects.toThrow(message);
    const other = await checkedFor(storage, "u2");
    await expect(
      storage.transaction((tx) => claimEmail(tx, "u1", null, now, other)),
    ).rejects.toThrow(message);
    expect((await storage.findMany("user", [])).map((u) => u.emailVerified)).toEqual([
      false,
      false,
    ]);
  });

  it("throws after begin, which forgets the user of an attempt that rolled back", async () => {
    const { storage, now } = await unverified();
    const verified = await checkedFor(storage, "u1");
    verified.begin();
    await expect(
      storage.transaction((tx) => claimEmail(tx, "u1", null, now, verified)),
    ).rejects.toThrow("authtempo: user.beforeVerify did not run before the claim");
  });
});
