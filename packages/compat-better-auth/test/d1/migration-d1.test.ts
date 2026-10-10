import { applyD1Migrations, env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { eq } from "./mapping-suite.js";
import { execD1 } from "./schema.js";

// Better Auth 1.7 tables as recorded, with rows that Better Auth's era wrote
// before the migration. The dates are in SQLite's CURRENT_TIMESTAMP form
// 'YYYY-MM-DD HH:MM:SS', not in the toISOString form core writes.
await execD1(`${BETTER_AUTH_SQLITE}
INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('o1','One','one@example.com',1,'2026-09-07 10:11:12','2026-09-07 10:11:12'), ('o2','Two','two@example.com',1,'2026-09-07 10:11:12','2026-09-07 10:11:12');
INSERT INTO "organization" ("id","name","slug","createdAt") VALUES ('org','Org','org','2026-09-07 10:11:12');
INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES ('m1','org','o1','owner','2026-09-07 10:11:12'), ('m2','org','o2','owner','2026-09-07 10:11:12');
`);

const tables = async () =>
  (
    await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY name`,
    ).all<{ name: string }>()
  ).results.map((r) => r.name);

// The tests run in order on one database: two refused runs, then the right file.
describe("the shipped D1 migration through applyD1Migrations", () => {
  it("refuses an integer Better Auth date and leaves no ta table (I-3)", async () => {
    await env.DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('int','Int','int@example.com',1,1757240000000,'2026-09-07 10:11:12')`,
    ).run();
    try {
      await expect(applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS)).rejects.toThrow(
        /CHECK constraint failed: tempo_auth_compat_every_better_auth_date_must_be_text/,
      );
      expect(await tables()).toEqual([]);
    } finally {
      await env.DB.prepare(`DELETE FROM "user" WHERE "id" = 'int'`).run();
    }
  });

  it("refuses the before-1.7 file on 1.7 tables with 'duplicate column name: issuer' and leaves no ta table (M-1)", async () => {
    await expect(applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS_BEFORE_17)).rejects.toThrow(
      /duplicate column name: issuer/,
    );
    expect(await tables()).toEqual([]);
  });

  it("lets an owner write on a Better Auth-era organization whose createdAt is in SQLite's date form", async () => {
    await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);
    expect(
      await env.DB.prepare(`SELECT "taUpdatedAt" FROM "organization" WHERE "id" = 'org'`).first(
        "taUpdatedAt",
      ),
    ).toBe("2026-09-07T10:11:12.000Z");
    const s = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: s.storage,
      limiter: s.limiter,
      mail: { send: async () => {} },
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
      organizations: {},
    });
    const caller = await s.storage.findOne("user", [eq("id", "o1")]);
    if (!caller) throw new Error("the caller is missing");
    // Demoting an owner runs ownerWrite: update organization where updatedAt = the read value.
    const r = await auth.api.updateMemberRole({
      user: caller,
      organizationId: "org",
      userId: "o2",
      role: "member",
    });
    expect(r).toMatchObject({ ok: true });
    expect(
      await env.DB.prepare(`SELECT "role" FROM "member" WHERE "id" = 'm2'`).first("role"),
    ).toBe("member");
  });
});
