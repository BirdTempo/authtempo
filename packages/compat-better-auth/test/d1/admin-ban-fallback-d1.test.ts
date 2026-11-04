import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { betterAuthPlainUsers, PASSWORD, plainShim } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";

// Migration 0009 on D1 for an app with no admin plugin (ruling 65 of plan
// 12f, X3). The user table has no banned, banReason, or banExpires column.
// So each read of the ban copy takes its fallback: not banned, and null.

await execD1(`${BETTER_AUTH_SQLITE}\n${betterAuthPlainUsers()}`);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the ban copy of migration 0009 on D1 with no admin plugin (ruling 65 X3)", () => {
  it("bans no user, and each user signs in", async () => {
    const rows = await env.DB.prepare(
      `SELECT "id", "taBannedAt", "taBanReason", "taBanUntil" FROM "user" ORDER BY "id"`,
    ).all();
    expect(rows.results).toEqual([
      { id: "ann", taBannedAt: null, taBanReason: null, taBanUntil: null },
      { id: "cy", taBannedAt: null, taBanReason: null, taBanUntil: null },
    ]);
    const version = await env.DB.prepare(
      "SELECT value FROM ta_meta WHERE key = 'compat_better_auth'",
    ).first<{ value: string }>();
    // Every shipped file ran: 0010 of plan 12k, 0011 of plan 12d, 0012 of plan 12i, and 0013 of
    // plan 12p come after 0009.
    expect(version?.value).toBe("13");
    const auth = plainShim(betterAuthSchemaStorage({ dialect: "d1", db: env.DB }));
    for (const id of ["ann", "cy"])
      await expect(
        auth.api.signInEmail({ body: { email: `${id}@example.com`, password: PASSWORD } }),
      ).resolves.toMatchObject({ user: { email: `${id}@example.com` } });
  });
});
