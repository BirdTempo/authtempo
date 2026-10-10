import { applyD1Migrations, env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash, type StorageAdapter } from "@tempo-auth/core";
import { beforeEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE, countForeignKeys } from "../fixtures.js";
import { at, eq, sqlNames } from "./mapping-suite.js";
import { count, execD1 } from "./schema.js";

// Better Auth's own SQLite SQL as recorded, with its seven foreign keys, then
// the shipped compat migration. D1 enforces foreign keys, and its undo log
// runs one statement at a time, so the key effects of an undo exist only here.
await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const later = new Date("2026-11-10T00:00:00.000Z");
const storage = () => betterAuthSchemaStorage({ dialect: "d1", db: env.DB });

/** core's sign-up rows: user, password, email identity, session, in the order given. */
const signUpRows =
  (order: "user-first" | "password-first", between?: () => Promise<void>) =>
  async (tx: StorageAdapter) => {
    const u = {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    };
    const password = {
      id: "p1",
      userId: "u1",
      hash: "pbkdf2-sha256$1000$x$y",
      createdAt: at,
      updatedAt: at,
    };
    if (order === "user-first") await tx.create("user", u);
    await tx.create("password", password);
    if (order === "password-first") await tx.create("user", u);
    await tx.create("identity", {
      id: "i1",
      userId: "u1",
      provider: "email",
      subject: "a@example.com",
      linkedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await tx.create("session", {
      id: "s1",
      userId: "u1",
      tokenHash: "ab".repeat(32),
      expiresAt: later,
      lastSeenAt: at,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      createdAt: at,
      updatedAt: at,
    });
    await between?.();
    throw new Error("boom");
  };

describe("the Better Auth foreign keys on D1", () => {
  beforeEach(sqlNames({}).truncate);

  it("runs on the fixture as recorded, with its seven foreign keys", async () => {
    expect(countForeignKeys(BETTER_AUTH_SQLITE)).toBe(7);
    const keys = await env.DB.prepare(
      `SELECT count(*) AS n FROM pragma_foreign_key_list('account')`,
    ).first("n");
    expect(keys).toBe(1);
  });

  it("runs core's email sign-up through createAuth: 1 user, 1 account row (the password), 1 session", async () => {
    const s = storage();
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: s.storage,
      limiter: s.limiter,
      mail: { send: async () => {} },
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    const pw = auth.api.password;
    if (!pw) throw new Error("the password api is missing");
    const r = await pw.signUp({
      email: "new@example.com",
      password: "a long passphrase 1",
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    // The sign-up writes the user, the password row, and a session; no email identity (core password.ts).
    expect([await count('"user"'), await count('"account"'), await count('"session"')]).toEqual([
      1, 1, 1,
    ]);
    // The pending$ row was activated by core's conditional update on account.password.
    const credential = await env.DB.prepare(
      `SELECT "password" FROM "account" WHERE "providerId" = 'credential'`,
    ).first("password");
    expect(credential).toMatch(/^pbkdf2-sha256\$1000\$/);
  });

  it("refuses a password row before its user row, and keeps no row", async () => {
    await expect(storage().storage.transaction(signUpRows("password-first"))).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect([await count('"user"'), await count('"account"')]).toEqual([0, 0]);
  });

  it("undoes an unverified sign-up completely, child rows first", async () => {
    await expect(storage().storage.transaction(signUpRows("user-first"))).rejects.toThrow("boom");
    expect([await count('"user"'), await count('"account"'), await count('"session"')]).toEqual([
      0, 0, 0,
    ]);
  });

  it("keeps the user that a claim verified inside the open transaction, and removes the claimant's rows", async () => {
    const s = storage().storage;
    // Another request, outside this transaction: an owner's claim verifies the row.
    const claim = async () => {
      expect(await s.update("user", [eq("id", "u1")], { emailVerified: true })).toBe(1);
    };
    await expect(s.transaction(signUpRows("user-first", claim))).rejects.toThrow("boom");
    expect(
      await env.DB.prepare(`SELECT "emailVerified" FROM "user" WHERE "id" = 'u1'`).first(
        "emailVerified",
      ),
    ).toBe(1);
    expect([await count('"account"'), await count('"session"')]).toEqual([0, 0]);
  });
});
