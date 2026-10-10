import { env } from "cloudflare:test";
import { runAdapterConformance } from "@tempo-auth/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzleAdapter } from "../../src/adapters/drizzle.js";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { d1CompatReady } from "../../src/storage/migration.js";

const TABLES = [
  "passkey",
  "invitation",
  "member",
  "organization",
  "verification",
  "account",
  "session",
  "user",
  "ta_limit",
];
async function truncate(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)));
}

runAdapterConformance("Better Auth tables on D1 (Better Auth's own SQLite SQL)", async () => {
  await truncate();
  return {
    adapter: betterAuthSchemaStorage({ dialect: "d1", db: env.DB }).storage,
    close: truncate,
  };
});

const at = new Date("2026-10-10T00:00:00.000Z");
const eq = <F extends string>(field: F, value: unknown) => ({ field, op: "eq" as const, value });

describe("the Better Auth mapping on D1", () => {
  beforeEach(truncate);
  const db = () => betterAuthSchemaStorage({ dialect: "d1", db: env.DB }).storage;

  it("keeps a user row that another request verified inside the open transaction (Task 4's undo on Better Auth's columns)", async () => {
    const s = db();
    await expect(
      s.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: at,
          updatedAt: at,
        });
        // Another request, outside this transaction: an owner's claim verifies the row.
        await s.update("user", [eq("id", "u1")], { emailVerified: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await s.findOne("user", [eq("id", "u1")]))?.emailVerified).toBe(true);
  });

  it("stores dates as ISO text and booleans as 1, so Better Auth-era rows compare in order", async () => {
    await env.DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('ba-u','Bea','bea@example.com',1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ).run();
    await db().create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    });
    const raw = await env.DB.prepare(
      `SELECT "createdAt", "emailVerified", "name" FROM "user" WHERE "id" = 'u1'`,
    ).first();
    expect(raw).toEqual({ createdAt: "2026-10-10T00:00:00.000Z", emailVerified: 1, name: "" });
    const older = await db().findMany("user", [
      { field: "createdAt", op: "lt", value: new Date("2026-10-01T00:00:00.000Z") },
    ]);
    expect(older.map((r) => r.id)).toEqual(["ba-u"]);
    expect(older[0]?.emailVerified).toBe(true);
  });

  it("converts the passkey key and reads Better Auth's empty transports as null", async () => {
    const s = db();
    await s.create("passkey", {
      id: "k1",
      userId: "u1",
      credentialId: "c1",
      publicKey: "-_-_AQ",
      counter: 0,
      transports: null,
      deviceType: "multiDevice",
      backedUp: true,
      name: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(
      await env.DB.prepare(`SELECT "publicKey" FROM "passkey" WHERE "id" = 'k1'`).first(
        "publicKey",
      ),
    ).toBe("+/+/AQ==");
    await env.DB.prepare(
      `INSERT INTO "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid","taUpdatedAt") VALUES ('ba-p','Laptop','+/+/AQ==','u1','ba-cred-id',3,'singleDevice',0,'','2026-09-01T00:00:00.000Z',NULL,'2026-09-01T00:00:00.000Z')`,
    ).run();
    expect(await s.findOne("passkey", [eq("credentialId", "ba-cred-id")])).toMatchObject({
      publicKey: "-_-_AQ",
      transports: null,
      backedUp: false,
    });
  });

  it("reverses a delete inside a transaction with every Better Auth column, also the ones core does not know", async () => {
    await env.DB.prepare(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","accessToken","createdAt","updatedAt","taLinkedAt") VALUES ('a1','https://accounts.google.com','g-sub','google','u1','at-1','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ).run();
    const s = db();
    await expect(
      s.transaction(async (tx) => {
        await tx.update("identity", [eq("id", "a1")], { updatedAt: at });
        await tx.delete("identity", [eq("id", "a1")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await env.DB.prepare(
      `SELECT "accessToken", "updatedAt" FROM "account" WHERE "id" = 'a1'`,
    ).first();
    expect(row).toEqual({ accessToken: "at-1", updatedAt: "2026-09-01T00:00:00.000Z" });
  });

  it("answers drizzleAdapter for a Drizzle D1 database with the same storage", async () => {
    const database = drizzleAdapter({ $client: env.DB }, { provider: "sqlite" });
    expect(database.dialect).toBe("d1");
    await database.storage.create("user", {
      id: "u9",
      email: "z@example.com",
      emailVerified: false,
      name: "Zed",
      image: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(await env.DB.prepare(`SELECT "name" FROM "user" WHERE "id" = 'u9'`).first("name")).toBe(
      "Zed",
    );
    expect(() => drizzleAdapter({ $client: {} }, { provider: "sqlite" })).toThrow(
      /needs a Drizzle database on D1/,
    );
    expect(() => drizzleAdapter({ $client: env.DB }, { provider: "mysql" })).toThrow(
      /"mysql" is refused/,
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
    const down = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(outage) }) }) };
    await expect(d1CompatReady(down)()).rejects.toBe(outage);
  });
});
