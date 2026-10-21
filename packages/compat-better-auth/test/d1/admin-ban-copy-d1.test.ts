import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import shipped0009 from "../../migrations/d1/0009_compat_schema_v12.sql?raw";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { adminShim, betterAuthBans, PASSWORD } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";
import { statementsOf } from "./sql.js";

// Ruling 62 M1 on D1: a Better Auth database with the admin plugin and
// banned users, before the shipped compat files. Migration 0009 copies each
// ban into core's columns, so the cutover unbans no user.

await execD1(`${BETTER_AUTH_SQLITE}\n${betterAuthBans("sqlite")}`);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the Better Auth ban copy of migration 0009 on D1 (ruling 62 M1)", () => {
  it("copies each ban, so a banned user gets BANNED_USER at sign-in", async () => {
    const rows = await env.DB.prepare(
      `SELECT "id", "taBannedAt", "taBanReason", "taBanUntil" FROM "user" ORDER BY "id"`,
    ).all();
    expect(rows.results).toEqual([
      {
        id: "ann",
        taBannedAt: "2026-09-01T00:00:00.000Z",
        taBanReason: "Spam",
        taBanUntil: null,
      },
      {
        id: "bob",
        taBannedAt: "2026-09-01T00:00:00.000Z",
        taBanReason: "Spam",
        taBanUntil: "2026-09-02T00:00:00.000Z",
      },
      { id: "cy", taBannedAt: null, taBanReason: null, taBanUntil: null },
    ]);
    const auth = adminShim(betterAuthSchemaStorage({ dialect: "d1", db: env.DB }));
    const signIn = (id: string) =>
      auth.api.signInEmail({ body: { email: `${id}@example.com`, password: PASSWORD } });
    await expect(signIn("ann")).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "BANNED_USER" },
    });
    // A ban that ended in Better Auth stays ended, and a user with no ban signs in.
    await expect(signIn("bob")).resolves.toMatchObject({ user: { email: "bob@example.com" } });
    await expect(signIn("cy")).resolves.toMatchObject({ user: { email: "cy@example.com" } });
  });

  it("changes nothing at a second run of the copy", async () => {
    const copy = statementsOf(shipped0009).filter((s) => s.startsWith('UPDATE "user"'));
    expect(copy).toHaveLength(1);
    await env.DB.prepare(
      `UPDATE "user" SET "updatedAt" = '2026-10-01T00:00:00.000Z', "banReason" = 'Other'`,
    ).run();
    for (const s of copy) await env.DB.prepare(s).run();
    const rows = await env.DB.prepare(
      `SELECT "id", "taBannedAt", "taBanReason" FROM "user" ORDER BY "id"`,
    ).all();
    expect(rows.results).toEqual([
      { id: "ann", taBannedAt: "2026-09-01T00:00:00.000Z", taBanReason: "Spam" },
      { id: "bob", taBannedAt: "2026-09-01T00:00:00.000Z", taBanReason: "Spam" },
      { id: "cy", taBannedAt: null, taBanReason: null },
    ]);
  });
});
