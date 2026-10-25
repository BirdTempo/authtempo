import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { adminApp, adminShim } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Plan 12f2 Task 7 (Wave B) on D1: Better Auth's create-user through core's
// operator create route, by a platform operator. D1 Free allows 50 queries
// per invocation (D1 limits page updated 21 April 2026, read 2026-10-21).
// This file has its own storage, so its operator is the first one.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the admin create of a user on D1 (plan 12f2 Task 7)", () => {
  it("creates a user through the shim in 50 queries or fewer", async () => {
    const setup = await adminApp(betterAuthSchemaStorage({ dialect: "d1", db: env.DB }));
    // One invocation: a new storage and a new shim over the counting binding.
    const { db, count } = counting(env.DB);
    const shim = adminShim(betterAuthSchemaStorage({ dialect: "d1", db }));
    const res = await shim.handler(
      new Request("https://api.example.com/api/auth/admin/create-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://api.example.com",
          cookie: setup.op,
        },
        body: JSON.stringify({
          email: "dee@example.com",
          name: "Dee",
          data: { emailVerified: true },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe("dee@example.com");
    // Core's route with firstSignIn none (no invitation row, no mail), then
    // the shim's read of the user row for { user }, and the factor read for
    // twoFactorEnabled (ruling 60 L2). Run of 2026-10-25.
    expect(count.queries).toBeLessThanOrEqual(50);
    expect(count.queries).toBe(17);
  });
});
