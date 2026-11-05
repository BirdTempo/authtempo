import { applyD1Migrations, env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash, type StorageAdapter } from "@authtempo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { NULL_PASSWORD_LOG } from "../../src/storage/statements.js";
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
      freshAt: at,
      actorId: null,
      activeTeamId: null,
      proved: false,
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
    const authWith = (uniformSignUp: boolean) =>
      createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: s.storage,
        limiter: s.limiter,
        mail: { send: async () => {} },
        password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp },
      });
    // The detailed answer of plan 8 writes the session row too (plan 12b).
    const pw = authWith(false).api.password;
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
    // The uniform answer (the default) writes the user and the password, and no session.
    const uniform = await authWith(true).api.password?.signUp({
      email: "other@example.com",
      password: "a long passphrase 1",
      ip: null,
      userAgent: null,
    });
    // The uniform answer carries the sign-up proof (ruling 11 of plan 12q).
    expect(uniform).toEqual({
      ok: true,
      value: { sent: true, signUpProof: expect.stringMatching(/^sp_[A-Za-z0-9_-]{43}$/) },
    });
    expect([await count('"user"'), await count('"account"'), await count('"session"')]).toEqual([
      2, 2, 1,
    ]);
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

  it("restores only the columns an update set, so a claim's emailVerified stays (final review M-1)", async () => {
    const s = storage().storage;
    await s.create("user", {
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
    await expect(
      s.transaction(async (tx) => {
        expect(await tx.update("user", [eq("id", "u1")], { updatedAt: later })).toBe(1);
        // Another request, outside this transaction: an owner's claim verifies the row.
        await env.DB.prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE "id" = 'u1'`).run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const back = await s.findOne("user", [eq("id", "u1")]);
    expect(back?.updatedAt).toEqual(at);
    expect(back?.emailVerified).toBe(true);
  });
});

describe("the plan 9b2 inputs on the recorded Better Auth tables", () => {
  beforeEach(sqlNames({}).truncate);
  const user = (id: string, email: string) => ({
    id,
    email,
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
    createdAt: at,
    updatedAt: at,
  });
  const identity = (id: string, userId: string, subject: string) => ({
    id,
    userId,
    provider: "email",
    subject,
    linkedAt: at,
    createdAt: at,
    updatedAt: at,
  });

  it("loses the rows that a cascade deletes when a transaction that deleted their parent fails", async () => {
    const s = storage().storage;
    await s.create("user", user("u1", "a@example.com"));
    await s.create("identity", identity("i1", "u1", "a@example.com"));
    await expect(
      s.transaction(async (tx) => {
        await tx.delete("user", [eq("id", "u1")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The undo log restores the user row. ON DELETE CASCADE deleted the account row inside
    // SQLite, outside the log, so no undo entry brings it back (adapter-d1 README).
    expect([await count('"user"'), await count('"account"')]).toEqual([1, 0]);
  });

  it("keeps every row when the child rows are deleted first, as core's deleteOrganization does", async () => {
    const s = storage().storage;
    await s.create("user", user("u1", "a@example.com"));
    await s.create("identity", identity("i1", "u1", "a@example.com"));
    await expect(
      s.transaction(async (tx) => {
        await tx.delete("identity", [eq("userId", "u1")]);
        await tx.delete("user", [eq("id", "u1")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect([await count('"user"'), await count('"account"')]).toEqual([1, 1]);
  });

  it("signs in a null account.password row as no password row, logs once, and a reset repairs it (Review Focus 5)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Better Auth 1.7.2 never writes this row; a hand-edited table can.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u1','Ada','ada@example.com',1,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')`,
        ),
        env.DB.prepare(
          `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('a1','local:credential','u1','credential','u1',NULL,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')`,
        ),
      ]);
      const mails: string[] = [];
      const s = storage();
      const auth = createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: s.storage,
        limiter: s.limiter,
        mail: { send: async (m) => void mails.push(m.text) },
        password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
      });
      const pw = auth.api.password;
      if (!pw) throw new Error("the password api is missing");
      const signIn = (password: string) =>
        pw.signIn({ email: "ada@example.com", password, ip: null, userAgent: null });
      expect(await signIn("a guess of one")).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
      expect(await signIn("a guess of two")).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
      expect(error.mock.calls).toEqual([[`${NULL_PASSWORD_LOG} (account a1)`]]);
      expect(await pw.requestReset({ email: "ada@example.com", ip: null })).toMatchObject({
        ok: true,
      });
      const token = decodeURIComponent(/token=([^\s&]+)/.exec(mails.at(-1) ?? "")?.[1] ?? "");
      expect(
        await pw.reset({ token, password: "a long new passphrase 1", ip: null, userAgent: null }),
      ).toMatchObject({ ok: true });
      expect(await signIn("a long new passphrase 1")).toMatchObject({ ok: true });
      expect(
        await env.DB.prepare(`SELECT "password" FROM "account" WHERE "id" = 'a1'`).first(
          "password",
        ),
      ).toMatch(/^pbkdf2-sha256\$1000\$/);
    } finally {
      error.mockRestore();
    }
  });

  it("reads a date in SQLite's space form as UTC, and refuses one it cannot read", async () => {
    await env.DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u2','Bo','bo@example.com',1,'2024-01-15 10:30:00','2024-01-15 10:30:00.5')`,
    ).run();
    const s = storage().storage;
    expect(await s.findOne("user", [eq("id", "u2")])).toMatchObject({
      createdAt: new Date("2024-01-15T10:30:00.000Z"),
      updatedAt: new Date("2024-01-15T10:30:00.500Z"),
    });
    await env.DB.prepare(`UPDATE "user" SET "updatedAt" = 'yesterday' WHERE "id" = 'u2'`).run();
    await expect(s.findOne("user", [eq("id", "u2")])).rejects.toMatchObject({
      code: "schema_mismatch",
      model: "user",
      fields: ["updatedAt"],
    });
  });
});
