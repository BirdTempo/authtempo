import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { adminApp, adminShim, PASSWORD } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Plan 12f Task 13 on D1, ruling 60 L6: the worst page of a ban through the
// shim. Core's ban ends at most one page of 500 sessions per call. D1 Free
// allows 50 queries per invocation (D1 limits page updated 21 April 2026,
// read 2026-10-21). This file has its own storage, so its operator is the first one.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the worst ban page of the admin plugin on D1 (ruling 60 L6)", () => {
  it("bans a user with 501 sessions in 50 queries or fewer", { timeout: 300_000 }, async () => {
    // The setup allows each call: 501 sessions of one user pass the sign-in limits.
    // The verify and the first sign-in of `user` open two of them.
    const setup = await adminApp({
      ...betterAuthSchemaStorage({ dialect: "d1", db: env.DB }),
      limiter: { allow: async () => true },
    });
    const ann = await setup.user("ann@example.com");
    for (let i = 0; i < 499; i++)
      await setup.call("/password/sign-in", { email: "ann@example.com", password: PASSWORD });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`)
      .bind(ann.id)
      .first<{ n: number }>();
    expect(before?.n).toBe(501);

    // One invocation: a new storage and a new shim over the counting binding, with the D1 limiter.
    const { db, count } = counting(env.DB);
    const invocation = adminShim(betterAuthSchemaStorage({ dialect: "d1", db }));
    const ban = await invocation.handler(
      new Request("https://api.example.com/api/auth/admin/ban-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://api.example.com",
          cookie: setup.op,
        },
        body: JSON.stringify({ userId: ann.id, banReason: "Spam" }),
      }),
    );
    expect(ban.status).toBe(200);
    expect(((await ban.json()) as { user: { banned: boolean } }).user.banned).toBe(true);
    // The reviewer's probe P4 counted 48 for 500, 501, and 700 sessions.
    // Ruling 60 L2 adds 1: the factor read for the user's twoFactorEnabled.
    // Ruling 51 of plan 12d raises OPERATOR_CALLS_BEFORE.user from 10 to 11 for the
    // session-cap read of a due refresh with sso.saml on. A chunk of the page costs 2
    // calls (the link read and the delete), so the page ends one chunk of 50 fewer:
    // 47 queries and 101 sessions left (run of 2026-10-22).
    // Ruling 78 of plan 12d: the handler takes the session row of the router, 1 query
    // fewer; the reserve keeps the call, so the page stays (run of 2026-10-24).
    expect(count.queries).toBeLessThanOrEqual(50);
    expect(count.queries).toBe(46);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`)
      .bind(ann.id)
      .first<{ n: number }>();
    // The sessions past the budget stay for the sweep, and core's ban rule
    // refuses each of them at every door until then.
    expect(left?.n).toBe(101);
  });
});
