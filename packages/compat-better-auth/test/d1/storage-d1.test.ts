import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzleAdapter } from "../../src/adapters/drizzle.js";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { d1CompatReady } from "../../src/storage/migration.js";
import { resolveNames } from "../../src/storage/names.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { at, eq, sqlNames } from "./mapping-suite.js";
import { execD1 } from "./schema.js";

// Better Auth's own SQLite SQL as recorded, with its seven foreign keys, then
// the shipped compat migration. Core's conformance suite and the mapping tests
// on these tables run in storage-d1-conformance-keyed.test.ts.
await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the Better Auth storage on D1, default names", () => {
  const { truncate } = sqlNames({});
  beforeEach(truncate);
  const db = () => betterAuthSchemaStorage({ dialect: "d1", db: env.DB }).storage;
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
  /** A stand-in for a Drizzle SQLite table: the name and columns symbols of drizzle-orm 0.45.2. */
  const drizzleTable = (
    name: string,
    columns: Record<string, { name: string; columnType: string }>,
  ) => ({
    [Symbol.for("drizzle:Name")]: name,
    [Symbol.for("drizzle:Columns")]: columns,
  });

  it("answers drizzleAdapter for a Drizzle D1 database with the same storage", async () => {
    const database = drizzleAdapter({ $client: env.DB }, { provider: "sqlite" });
    expect(database.dialect).toBe("d1");
    await database.storage.create("user", { ...user("u9", "z@example.com"), name: "Zed" });
    expect(await env.DB.prepare(`SELECT "name" FROM "user" WHERE "id" = 'u9'`).first("name")).toBe(
      "Zed",
    );
    // The refusals ride on the database and join betterAuth's one list (plan 9b).
    expect(drizzleAdapter({ $client: {} }, { provider: "sqlite" }).refusals).toEqual([
      "database: drizzleAdapter needs a Drizzle database on D1 (drizzle-orm/d1); other SQLite drivers are refused",
    ]);
    const mysql = drizzleAdapter({ $client: env.DB }, { provider: "mysql" });
    expect(mysql.refusals?.[0]).toMatch(/"mysql" is refused/);
    expect(mysql.refusals).toEqual([
      'database.provider: "mysql" is refused; authtempo runs on Postgres and D1',
    ]);
    expect(() => mysql.storage.findOne("user", [])).toThrow(/"mysql" is refused/);
  });

  it("refuses a Drizzle SQLite schema with an integer timestamp column (I-3)", () => {
    const schema = {
      user: drizzleTable("user", {
        id: { name: "id", columnType: "SQLiteText" },
        createdAt: { name: "createdAt", columnType: "SQLiteTimestamp" },
        updatedAt: { name: "updatedAt", columnType: "SQLiteText" },
      }),
    };
    expect(drizzleAdapter({ $client: env.DB }, { provider: "sqlite", schema }).refusals).toEqual([
      "database.schema.user.createdAt: an integer timestamp column is refused; on D1 authtempo reads Better Auth's dates as ISO 8601 text",
    ]);
    const text = {
      user: drizzleTable("user", { createdAt: { name: "createdAt", columnType: "SQLiteText" } }),
    };
    expect(drizzleAdapter({ $client: env.DB }, { provider: "sqlite", schema: text }).dialect).toBe(
      "d1",
    );
  });

  it("refuses every call with schema_mismatch while ta_meta or its compat row is missing, and passes other D1 errors through", async () => {
    // Not in the brief: the D1 counterpart of Task 5's "refuses every call before the migration".
    await env.DB.prepare("ALTER TABLE ta_meta RENAME TO ta_meta_aside").run();
    try {
      await expect(db().findOne("user", [eq("id", "x")])).rejects.toMatchObject({
        code: "schema_mismatch",
        fields: ["none"],
      });
    } finally {
      await env.DB.prepare("ALTER TABLE ta_meta_aside RENAME TO ta_meta").run();
    }
    await env.DB.prepare("DELETE FROM ta_meta WHERE key = 'compat_better_auth'").run();
    try {
      await expect(db().findOne("user", [eq("id", "x")])).rejects.toMatchObject({
        code: "schema_mismatch",
        fields: ["compat_better_auth:none"],
      });
    } finally {
      await env.DB.prepare(
        "INSERT INTO ta_meta (key, value) VALUES ('compat_better_auth', '1')",
      ).run();
    }
    await expect(db().findOne("user", [eq("id", "x")])).resolves.toBeNull();
    const outage = new Error("D1_ERROR: network connection lost");
    const down = {
      prepare: () => ({
        bind: () => ({ first: () => Promise.reject(outage) }),
        all: () => Promise.reject(outage),
      }),
    };
    await expect(d1CompatReady(down, resolveNames())()).rejects.toBe(outage);
  });

  it("refuses every call with schema_mismatch while account has no unique index on (issuer, accountId) (I-2)", async () => {
    await env.DB.prepare('DROP INDEX "account_issuer_accountId_uidx"').run();
    try {
      await expect(db().findOne("user", [eq("id", "x")])).rejects.toMatchObject({
        code: "schema_mismatch",
        model: "identity",
        message: expect.stringMatching(/no unique index on account \(issuer, accountId\)/),
      });
      // A partial index and a plain index on the two columns do not count.
      await env.DB.prepare(
        'CREATE UNIQUE INDEX "partial_issuer" ON "account" ("issuer", "accountId") WHERE "issuer" IS NOT NULL',
      ).run();
      await env.DB.prepare(
        'CREATE INDEX "plain_issuer" ON "account" ("issuer", "accountId")',
      ).run();
      await expect(db().findOne("user", [eq("id", "x")])).rejects.toMatchObject({
        code: "schema_mismatch",
      });
      // Any name, and any case of the column names, counts.
      await env.DB.prepare(
        'CREATE UNIQUE INDEX "other_name" ON "account" ("ISSUER", "accountid")',
      ).run();
      await expect(db().findOne("user", [eq("id", "x")])).resolves.toBeNull();
    } finally {
      for (const i of ["partial_issuer", "plain_issuer", "other_name"])
        await env.DB.prepare(`DROP INDEX IF EXISTS "${i}"`).run();
      await env.DB.prepare(
        'CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")',
      ).run();
    }
  });

  it("reports the right field and restores the right row when a configured name differs in case from the table (M-3)", async () => {
    // SQLite matches names without case, so every statement runs; the lookups of the names must match too.
    const naming = { columns: { user: { id: "ID", email: "EMAIL" } } };
    const s = betterAuthSchemaStorage({ dialect: "d1", db: env.DB, ...naming }).storage;
    await s.create("user", user("u1", "a@example.com"));
    await expect(s.create("user", user("u2", "a@example.com"))).rejects.toMatchObject({
      code: "unique_violation",
      model: "user",
      fields: ["email"],
    });
    await expect(
      s.transaction(async (tx) => {
        await tx.update("user", [eq("id", "u1")], { name: "Changed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await s.findOne("user", [eq("id", "u1")]))?.name).toBeNull();
  });
});
